import { Braces, FileCode2, Link2, TestTube2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Entity, ProjectMap, TraceBinding } from "../types.ts";

export function FieldTraceLens({ data, onSelect }: { data: ProjectMap; onSelect(entity: Entity): void }) {
  const [activeId, setActiveId] = useState<string>();
  const entities = useMemo(() => new Map(data.nodes.map((entity) => [entity.id, entity])), [data.nodes]);
  const bindings = (data.bindings ?? []).filter((binding) => binding.status === "formal");

  function focus(binding: TraceBinding, side: "design" | "engineering") {
    setActiveId(binding.id);
    const entity = entities.get(side === "design" ? binding.design_id : binding.engineering_id);
    if (entity) onSelect(entity);
  }

  return <section className="field-trace-lens" data-testid="field-trace-lens">
    <div className="trace-column-heads" aria-hidden="true">
      <div><Braces size={14} /><span>左 · 设计规格字段</span></div>
      <div className="trace-head-mark"><Link2 size={13} /> MARK</div>
      <div><FileCode2 size={14} /><span>右 · 工程文件与代码</span></div>
    </div>
    <div className="trace-binding-list">
      {bindings.length === 0 && <div className="trace-empty">当前服务尚未返回字段—代码映射，请重启本地控制面后重试。</div>}
      {bindings.map((binding) => {
        const design = entities.get(binding.design_id);
        const engineering = entities.get(binding.engineering_id);
        const active = activeId === binding.id;
        const muted = Boolean(activeId) && !active;
        return <article className={`trace-binding-row ${active ? "is-active" : ""} ${muted ? "is-muted" : ""}`} data-testid={`trace-binding-${binding.mark}`} data-active={active ? "true" : "false"} key={binding.id}>
          <button className="trace-side trace-design-field" onClick={() => focus(binding, "design")} aria-label={`聚焦设计字段 ${binding.mark}`}>
            <span className="trace-human-context">{design?.title ?? binding.design_id}</span>
            <strong>{binding.field_label}</strong>
            <code>{binding.field_path}</code>
          </button>
          <button className="trace-mark" onClick={() => focus(binding, "design")} aria-label={`聚焦映射 ${binding.mark}`}>
            <span>{binding.mark}</span><i>↔</i>
          </button>
          <button className="trace-side trace-code-target" onClick={() => focus(binding, "engineering")} aria-label={`聚焦工程代码 ${binding.mark}`}>
            <span className="trace-human-context">{engineering?.title ?? binding.engineering_id}</span>
            <strong>{binding.symbol}</strong>
            <code>{binding.file_path}</code>
            {binding.test_paths.length > 0 && <span className="trace-test"><TestTube2 size={11} />{binding.test_paths[0]}</span>}
          </button>
        </article>;
      })}
    </div>
    <footer className="trace-legend"><span><i className="legend-selected" />当前映射</span><span><i className="legend-design" />规格字段</span><span><i className="legend-code" />实现位置</span><small>{activeId ? "已锁定一组字段—代码映射；点击其他 MARK 切换。" : "点击左侧字段、MARK 或右侧代码，另一侧会同步高亮。"}</small></footer>
  </section>;
}
