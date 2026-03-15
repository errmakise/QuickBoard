import { describe, it, expect } from 'vitest'

import { mount } from '@vue/test-utils'
import App from '../App.vue'

describe('App', () => {
  it('mounts renders properly', () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          Whiteboard: { template: '<div data-test="whiteboard-stub"></div>' }
        }
      }
    })
    expect(wrapper.find('[data-test="whiteboard-stub"]').exists()).toBe(true)
  })
})
