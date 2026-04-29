import json
from pathlib import Path


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _savefig(fig, out_path: Path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=180, bbox_inches="tight")


def main():
    import matplotlib
    import matplotlib.pyplot as plt

    matplotlib.rcParams["font.sans-serif"] = ["Microsoft YaHei", "DejaVu Sans", "Arial"]
    matplotlib.rcParams["axes.unicode_minus"] = False

    thesis_dir = Path(__file__).resolve().parents[1]
    figures_dir = thesis_dir / "figures"
    reports_dir = thesis_dir.parents[1] / "doc" / "test_reports"

    render = _read_json(reports_dir / "quickboard_render_perf_20260410-100903.json")
    baseline = render["results"]["baseline"]["phases"]
    optimized = render["results"]["optimized"]["phases"]
    phases = ["idle", "pan", "zoom"]

    def phase_avg(ph):
        samples = ph["samples"]
        return sum(s["avgRenderMs"] for s in samples) / len(samples)

    baseline_avg = [phase_avg(baseline[p]) for p in phases]
    optimized_avg = [phase_avg(optimized[p]) for p in phases]

    fig, ax = plt.subplots(figsize=(7.2, 3.6))
    x = list(range(len(phases)))
    w = 0.36
    ax.bar([i - w / 2 for i in x], baseline_avg, width=w, label="Baseline", color="#8da0cb")
    ax.bar([i + w / 2 for i in x], optimized_avg, width=w, label="Optimized", color="#66c2a5")
    ax.set_xticks(x)
    ax.set_xticklabels(phases)
    ax.set_ylabel("avg render time (ms)")
    ax.grid(axis="y", alpha=0.25)
    ax.legend(ncols=2, frameon=False, loc="upper right")
    _savefig(fig, figures_dir / "render_perf_avg.png")
    plt.close(fig)

    sync = _read_json(reports_dir / "quickboard_sync_benchmark_20260410-183708.json")
    runs = {r["mode"]: r for r in sync["runs"]}
    naive = runs["naive"]
    lww = runs["lww"]

    fig, ax = plt.subplots(figsize=(7.2, 3.6))
    labels = ["p50", "p95", "p99"]
    naive_vals = [naive["latency"][k] for k in labels]
    lww_vals = [lww["latency"][k] for k in labels]
    x = list(range(len(labels)))
    w = 0.36
    ax.bar([i - w / 2 for i in x], naive_vals, width=w, label="naive", color="#fc8d62")
    ax.bar([i + w / 2 for i in x], lww_vals, width=w, label="lww", color="#66c2a5")
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylabel("end-to-end latency (ms)")
    ax.grid(axis="y", alpha=0.25)
    ax.legend(ncols=2, frameon=False, loc="upper right")
    _savefig(fig, figures_dir / "sync_latency_percentiles.png")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(6.4, 3.6))
    labels = ["before", "after"]
    naive_vals = [naive["convergence"]["beforeDistinctHashes"], naive["convergence"]["afterDistinctHashes"]]
    lww_vals = [lww["convergence"]["beforeDistinctHashes"], lww["convergence"]["afterDistinctHashes"]]
    x = list(range(len(labels)))
    w = 0.36
    ax.bar([i - w / 2 for i in x], naive_vals, width=w, label="naive", color="#fc8d62")
    ax.bar([i + w / 2 for i in x], lww_vals, width=w, label="lww", color="#66c2a5")
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylabel("distinct hashes")
    ax.grid(axis="y", alpha=0.25)
    ax.legend(ncols=2, frameon=False, loc="upper right")
    _savefig(fig, figures_dir / "sync_convergence.png")
    plt.close(fig)

    ghost = _read_json(reports_dir / "quickboard_ghost_brush_20260405-185242.json")
    baseline_msgs = ghost["notes"]["baselineMessagesIfUnbatched"]
    actual_msgs = ghost["metrics"]["messagesEmitted"]

    fig, ax = plt.subplots(figsize=(5.4, 3.6))
    ax.bar(["unbatched", "batched"], [baseline_msgs, actual_msgs], color=["#fc8d62", "#66c2a5"])
    ax.set_ylabel("messages in 10s")
    ax.grid(axis="y", alpha=0.25)
    _savefig(fig, figures_dir / "ghost_brush_messages.png")
    plt.close(fig)


if __name__ == "__main__":
    main()
