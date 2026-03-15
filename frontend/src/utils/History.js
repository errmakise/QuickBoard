/**
 * 命令模式 (Command Pattern) 实现撤销/重做
 * 
 * 核心概念：
 * 1. Command (命令): 把每一个操作（如移动、变色、删除）封装成一个对象。
 *    每个命令对象必须有两个方法：
 *    - execute(): 执行操作 (Redo 时调用)
 *    - undo(): 撤销操作 (Undo 时调用)
 * 
 * 2. Stack (栈): 
 *    - undoStack: 存放已经做过的操作。按 Ctrl+Z 时，从这里弹出一个命令执行 undo()。
 *    - redoStack: 存放刚刚撤销的操作。按 Ctrl+Y 时，从这里弹出一个命令执行 execute()。
 */

import * as fabric from 'fabric';
// 移除未使用的导入，所有依赖通过 this.app 注入

// --- 基础命令类 ---
class Command {
  constructor(app) {
    this.app = app; // app 包含了 canvas, objectMap, socketService 等引用
  }
  execute() {}
  undo() {}
}

// --- 1. 添加对象命令 ---
export class AddCommand extends Command {
  constructor(app, object) {
    super(app);
    this.object = object;
    this.id = object.id;
    // 增加 json 保存，用于后续恢复（如果引用失效）
    this.json = object.toJSON(); 
  }

  execute() {
    // 重做：把对象加回去
    // [关键修复] 在重做之前，先检查CRDT状态，确保对象没有被标记为删除
    const currentCrdtState = this.app.crdtManager.getObjectState(this.id);
    
    // 如果对象在CRDT中被标记为删除，不要重做添加操作
    if (currentCrdtState && currentCrdtState.data && currentCrdtState.data._deleted) {
      return;
    }
    
    if (!this.app.objectMap.has(this.id)) {
      // 优先尝试使用 enlivenObjects 恢复，因为 this.object 可能已经过时
      fabric.util.enlivenObjects([this.json]).then((objects) => {
          const newObj = objects[0];
          if (!newObj) {
              return;
          }
          
          newObj.id = this.id;
          
          // [关键修复] 针对 Path 对象的特殊处理
          // 如果是 Path，可能需要强制设置 strokeWidth，防止变细
          if (newObj.type === 'path' && newObj.strokeWidth) {
              // 某些情况下缩放会导致 strokeWidth 视觉上变细，这里可以加个系数或者强制重置
              // newObj.set('strokeWidth', this.object.strokeWidth); 
          }

          this.app.canvas.add(newObj);
          this.app.objectMap.set(this.id, newObj);
          this.app.canvas.requestRenderAll(); 
          
          // 更新引用
          this.object = newObj;

          // [关键修复] 添加操作使用递增时间戳，确保操作优先级
          let newTime;
          if (currentCrdtState) {
            newTime = Math.max(...Object.values(currentCrdtState.timestamps)) + 100;
          } else {
            newTime = this.app.crdtManager.getCurrentTimestamp() + 100;
          }
          const crdtState = this.app.crdtManager.localUpdateWithTimestamp(this.id, newObj.toJSON(), newTime);
          this.app.socketService.emit('draw-event', { roomId: this.app.roomId, ...crdtState });
      }).catch(() => null);
    } else {
      return;
    }
  }

  undo() {
    // 撤销：把对象移除
    // [最终修复] 确保本地UI立即更新，然后异步发送CRDT更新
    const liveObject = this.app.objectMap.get(this.id);
    if (liveObject) {
      if (this.app.canvas.getActiveObject() === liveObject) {
        this.app.canvas.discardActiveObject();
      }
      this.app.canvas.remove(liveObject);
    }

    const objects = this.app.canvas.getObjects();
    for (let i = objects.length - 1; i >= 0; i--) {
      if (objects[i].id === this.id) {
        if (this.app.canvas.getActiveObject() === objects[i]) {
          this.app.canvas.discardActiveObject();
        }
        this.app.canvas.remove(objects[i]);
      }
    }

    this.app.objectMap.delete(this.id);
    this.app.canvas.renderAll();

    const currentCrdtState = this.app.crdtManager.getObjectState(this.id);
    let newTime;

    if (currentCrdtState && currentCrdtState.timestamps && Object.keys(currentCrdtState.timestamps).length > 0) {
      newTime = Math.max(...Object.values(currentCrdtState.timestamps)) + 100;
    } else {
      newTime = this.app.crdtManager.getCurrentTimestamp() + 100;
    }

    const crdtState = this.app.crdtManager.deleteWithTimestamp(this.id, newTime);
    if (crdtState) {
      this.app.socketService.emit('draw-event', { roomId: this.app.roomId, ...crdtState });
    }
  }
}

// --- 2. 删除对象命令 ---
export class RemoveCommand extends Command {
  constructor(app, object) {
    super(app);
    this.object = object;
    this.id = object.id;
    this.json = object.toJSON(); // 保存删除前的状态，以便恢复
  }

  execute() {
    // 重做：再次删除
    // [修复] 同样使用 ID 查找，而不是依赖 this.object
    const liveObject = this.app.objectMap.get(this.id);
    if (liveObject) {
        this.app.canvas.remove(liveObject);
        this.app.objectMap.delete(this.id);
        this.app.canvas.requestRenderAll();
    } else {
        const canvasObj = this.app.canvas.getObjects().find(o => o.id === this.id);
        if (canvasObj) {
            this.app.canvas.remove(canvasObj);
            this.app.canvas.requestRenderAll();
        }
    }
    
    // [关键修复] 删除操作使用递增时间戳，确保操作优先级
    const currentCrdtState = this.app.crdtManager.getObjectState(this.id);
    if (currentCrdtState) {
      // 使用当前最高时间戳 + 100，确保删除操作有极高优先级
      const newTime = Math.max(...Object.values(currentCrdtState.timestamps)) + 100;
      const crdtState = this.app.crdtManager.deleteWithTimestamp(this.id, newTime);
      if (crdtState) {
          this.app.socketService.emit('draw-event', { roomId: this.app.roomId, ...crdtState });
      }
    }
  }

  undo() {
    // 撤销：恢复对象
    // [使用 enlivenObjects 重建对象]
    // 彻底解决旧对象引用失效或状态污染的问题
    if (this.json) {
        // [防御性编程] 如果已经存在同 ID 对象（可能被其他人或重复操作恢复了），先移除
        const existingObj = this.app.objectMap.get(this.id);
        if (existingObj) {
            this.app.canvas.remove(existingObj);
        }

        fabric.util.enlivenObjects([this.json]).then((objects) => {
            const newObj = objects[0];
            if (!newObj) return;

            // 恢复 ID
            newObj.id = this.id;
            this.object = newObj; // 更新引用的对象

            this.app.canvas.add(newObj);
            this.app.objectMap.set(this.id, newObj);
            
            // 强制选中并更新
            newObj.setCoords();
            this.app.canvas.setActiveObject(newObj);
            this.app.canvas.requestRenderAll();
            
            // [关键修复] 恢复操作使用递增时间戳，确保操作优先级
            const currentCrdtState = this.app.crdtManager.getObjectState(this.id);
            let newTime;
            if (currentCrdtState) {
              // 如果对象已存在，使用当前最高时间戳 + 100，确保恢复操作有极高优先级
              newTime = Math.max(...Object.values(currentCrdtState.timestamps)) + 100;
            } else {
              // 如果是新恢复的对象，使用当前逻辑时钟 + 100
              newTime = this.app.crdtManager.getCurrentTimestamp() + 100;
            }
            const crdtState = this.app.crdtManager.localUpdateWithTimestamp(this.id, newObj.toJSON(), newTime);
            this.app.socketService.emit('draw-event', { roomId: this.app.roomId, ...crdtState });
        });
    }
  }
}

// --- 3. 修改对象命令 (移动、缩放、旋转) ---
export class ModifyCommand extends Command {
  constructor(app, object, beforeState, afterState) {
    super(app);
    this.object = object;
    this.id = object.id;
    this.before = beforeState; // 修改前的属性 (如 { left: 100, top: 100 })
    this.after = afterState;   // 修改后的属性 (如 { left: 200, top: 200 })
  }

  execute() {
    // 重做：应用新属性
    // [修复] 获取当前画布上的实时对象，而不是使用可能失效的 this.object 引用
    const liveObject = this.app.objectMap.get(this.id);
    if (liveObject) {
        liveObject.set(this.after);
        liveObject.setCoords(); // 更新控制点
        this.app.canvas.requestRenderAll();
    }
    
    // [关键修复] 重做操作使用原始时间戳，避免被服务器误判为旧数据
    const currentCrdtState = this.app.crdtManager.getObjectState(this.id);
    
    if (currentCrdtState) {
        // 使用当前最新时间戳 + 100，确保重做操作优先级高于当前状态
        const newTime = Math.max(...Object.values(currentCrdtState.timestamps)) + 100;
        const crdtState = this.app.crdtManager.localUpdateWithTimestamp(this.id, this.after, newTime);
        this.app.socketService.emit('draw-event', { roomId: this.app.roomId, ...crdtState });
    } else {
        // 如果没有CRDT状态，直接使用当前时间戳
        const crdtState = this.app.crdtManager.localUpdate(this.id, this.after);
        this.app.socketService.emit('draw-event', { roomId: this.app.roomId, ...crdtState });
    }
  }

  undo() {
    // 撤销：应用旧属性
    // [修复] 获取当前画布上的实时对象
    const liveObject = this.app.objectMap.get(this.id);
    if (liveObject) {
        liveObject.set(this.before);
        liveObject.setCoords();
        this.app.canvas.requestRenderAll();
    }
    
    // [关键修复] 撤销操作使用原始时间戳，避免被服务器误判为旧数据
    // 我们需要获取当前对象的最新时间戳，确保撤销操作能被正确应用
    const currentCrdtState = this.app.crdtManager.getObjectState(this.id);
    
    if (currentCrdtState) {
        // 使用当前最新时间戳 + 100，确保撤销操作优先级高于当前状态
        const newTime = Math.max(...Object.values(currentCrdtState.timestamps)) + 100;
        const crdtState = this.app.crdtManager.localUpdateWithTimestamp(this.id, this.before, newTime);
        this.app.socketService.emit('draw-event', { roomId: this.app.roomId, ...crdtState });
    } else {
        // 如果没有CRDT状态，直接使用当前时间戳
        const crdtState = this.app.crdtManager.localUpdate(this.id, this.before);
        this.app.socketService.emit('draw-event', { roomId: this.app.roomId, ...crdtState });
    }
  }
}

// --- 历史记录管理器 ---
export class HistoryManager {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
    this.maxSize = 50; // 限制历史记录步数，防止内存溢出
  }

  /**
   * 执行新操作
   * @param {Command} command 
   */
  push(command) {
    this.undoStack.push(command);
    // 每次有新操作，redo 栈就失效了 (就像你走了一条新路，回不去旧的分支了)
    this.redoStack = [];
    
    // 限制大小
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift(); // 移除最早的记录
    }
  }

  undo() {
    if (this.undoStack.length === 0) return;
    
    const command = this.undoStack.pop();
    command.undo(); // 执行反向操作
    this.redoStack.push(command); // 放入 redo 栈
    return command;
  }

  redo() {
    if (this.redoStack.length === 0) return;
    
    const command = this.redoStack.pop();
    command.execute(); // 重新执行操作
    this.undoStack.push(command); // 放回 undo 栈
    return command;
  }

  /**
   * 清空历史栈（撤销/重做）。
   * 典型场景：
   * - 房间重置：所有历史都应失效，避免用户在“新房间”里撤销出旧房间的操作。
   */
  reset() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

export default new HistoryManager();
