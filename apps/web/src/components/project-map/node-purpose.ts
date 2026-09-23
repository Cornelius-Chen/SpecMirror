import type { EngineeringNode } from "@epm/domain";

export type NodePurposeSource = "objective" | "contribution" | "scope" | "output" | "missing";
export interface NodePurpose { text: string; fullText: string; source: NodePurposeSource }

const PLACEHOLDER = /^(请说明|等待.+补充|待补充|尚未说明|用途尚待|目标尚待|完成可供用户使用的完整功能|按具体交付能力分配下级工作)/;
const MAX_VISIBLE_CHARS = 26;
const clean = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
const comparable = (value: string) => clean(value).replace(/[：:，,。.!！?？；;、\s]/g, "").toLocaleLowerCase();
const punctuate = (value: string) => /[。！？!?…]$/.test(value) ? value : value + "。";

function concise(value: string): string {
  let result = clean(value).replace(/^(目标|用途|目的|方向调整|本项工作)\s*[：:]\s*/, "");
  const sentenceEnd = result.search(/[。！？!?]/);
  if (sentenceEnd >= 0) result = result.slice(0, sentenceEnd + 1);
  if (Array.from(result).length > MAX_VISIBLE_CHARS) {
    const colon = result.indexOf("：");
    if (colon >= 10 && colon <= MAX_VISIBLE_CHARS + 4) result = punctuate(result.slice(0, colon));
  }
  if (Array.from(result).length > MAX_VISIBLE_CHARS) {
    const clause = result.split(/[；;]/, 1)[0].trim();
    if (Array.from(clause).length >= 10 && clause !== result) result = punctuate(clause);
  }
  if (Array.from(result).length > MAX_VISIBLE_CHARS) {
    const clauses = result.replace(/[。！？!?]$/, "").split(/[，,]/).map(item => item.trim()).filter(Boolean);
    let selected = "";
    for (const clause of clauses) {
      const next = selected ? `${selected}，${clause}` : clause;
      if (Array.from(next).length > MAX_VISIBLE_CHARS) break;
      selected = next;
    }
    result = selected && selected !== clauses.join("，") ? punctuate(selected) : `${Array.from(result).slice(0, MAX_VISIBLE_CHARS).join("")}…`;
  }
  return punctuate(result);
}

function usable(value: string, title: string): boolean {
  const text = clean(value);
  return Boolean(text) && !PLACEHOLDER.test(text) && comparable(text) !== comparable(title);
}

function addsMeaning(value: string, title: string): boolean {
  const candidate = comparable(value), name = comparable(title);
  return Boolean(candidate) && Boolean(name) && !candidate.includes(name) && !name.includes(candidate);
}

/** Presentation-only purpose text. It summarizes stored contract fields and never changes the node. */
export function projectNodePurpose(node: EngineeringNode): NodePurpose {
  const distinctOutput = node.delivery?.outputs.find(item => usable(item.title, node.title) && addsMeaning(item.title, node.title))?.title ?? "";
  const scope = node.delivery?.included.length ? `负责${node.delivery.included.slice(0, 2).join("、")}` : "";
  const candidates: Array<{ source: NodePurposeSource; value: string }> = [
    { source: "objective", value: clean(node.objective) },
    { source: "contribution", value: clean(node.contribution?.summary) },
    { source: "scope", value: scope && addsMeaning(scope, node.title) ? scope : "" },
    { source: "output", value: distinctOutput ? `产出${distinctOutput}` : "" }
  ];
  const chosen = candidates.find(item => usable(item.value, node.title));
  if (!chosen) return { source: "missing", text: "用途尚待说明。", fullText: "用途尚待说明。" };
  return { source: chosen.source, text: concise(chosen.value), fullText: punctuate(clean(chosen.value)) };
}
