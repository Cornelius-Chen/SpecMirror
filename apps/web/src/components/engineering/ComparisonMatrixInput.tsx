import { newId } from "./shared.ts";

export const COMPARISON_MATRIX_ID = "capability:designer:view.comparison_decision_matrix";
const scenarios = { pricing: "比较费用与报价", plan_selection: "选择合适的方案", feature_comparison: "对照功能与特点", option_tradeoff: "权衡方案的取舍" };
type Cell = string | number | boolean;
interface Dimension { id: string; label: string; unit: string; source: string }
interface Option { id: string; label: string; values: Record<string, Cell> }
interface Matrix { title: string; fit_context: string; dimensions: Dimension[]; options: Option[] }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";

export function blankComparisonInput(): Record<string, unknown> {
  const dimensionId = newId("dimension");
  return { title: "", fit_context: "option_tradeoff", dimensions: [{ id: dimensionId, label: "", unit: "", source: "" }], options: [0, 1].map(() => ({ id: newId("option"), label: "", values: { [dimensionId]: "" } })) };
}

function editableMatrix(input: Record<string, unknown>): Matrix {
  const dimensions = (Array.isArray(input.dimensions) && input.dimensions.length ? input.dimensions : [{}]).map((raw, index) => {
    const item = record(raw); return { id: string(item.id) || `dimension-${index + 1}`, label: string(item.label), unit: string(item.unit), source: string(item.source) };
  });
  const options = (Array.isArray(input.options) && input.options.length ? input.options : [{}, {}]).map((raw, index) => {
    const item = record(raw); const values = record(item.values);
    return { id: string(item.id) || `option-${index + 1}`, label: string(item.label), values: Object.fromEntries(dimensions.map((dimension) => {
      const cell = values[dimension.id]; return [dimension.id, ["string", "number", "boolean"].includes(typeof cell) ? cell as Cell : ""];
    })) };
  });
  return { title: string(input.title), fit_context: string(input.fit_context), dimensions, options };
}

export function comparisonInputErrors(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const requireText = (value: unknown, label: string, limit = 300) => { if (typeof value !== "string" || !value.trim()) errors.push(`请填写${label}`); else if (value.length > limit) errors.push(`${label}最多 ${limit} 字`); };
  requireText(input.title, "比较题目");
  if (!(Object.hasOwn(scenarios, string(input.fit_context)))) errors.push("请选择适用场景");
  const dimensions = Array.isArray(input.dimensions) ? input.dimensions : [];
  const options = Array.isArray(input.options) ? input.options : [];
  if (dimensions.length < 1 || dimensions.length > 20) errors.push("请保留 1–20 个比较维度");
  if (options.length < 2 || options.length > 6) errors.push("请保留 2–6 个方案");
  const dimensionIds = new Set<string>(); const optionIds = new Set<string>();
  dimensions.forEach((raw, index) => {
    const dimension = record(raw); const label = `维度 ${index + 1}`;
    requireText(dimension.id, `${label}的标识`, 80); requireText(dimension.label, `${label}的名称`); requireText(dimension.unit, `${label}的单位`); requireText(dimension.source, `${label}的资料来源`, 1000);
    if (dimensionIds.has(string(dimension.id))) errors.push(`${label}的标识重复，请在高级输入中修正`);
    dimensionIds.add(string(dimension.id));
  });
  options.forEach((raw, index) => {
    const option = record(raw); const label = `方案 ${index + 1}`; const values = record(option.values);
    requireText(option.id, `${label}的标识`, 80); requireText(option.label, `${label}的名称`);
    if (optionIds.has(string(option.id))) errors.push(`${label}的标识重复，请在高级输入中修正`);
    optionIds.add(string(option.id));
    dimensions.forEach((rawDimension, dimensionIndex) => {
      const dimension = record(rawDimension); const value = values[string(dimension.id)]; const field = `${label}的「${string(dimension.label) || `维度 ${dimensionIndex + 1}`}」比较值`;
      if (!["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value) || typeof value === "string" && !value.trim()) errors.push(`请填写${field}`);
      else if (String(value).length > 2000) errors.push(`${field}最多 2000 字`);
    });
  });
  return errors;
}

export function ComparisonMatrixInput({ input, onChange }: { input: Record<string, unknown>; onChange: (input: Record<string, unknown>) => void }) {
  const matrix = editableMatrix(input); const errors = comparisonInputErrors(input);
  const update = (patch: Partial<Matrix>) => onChange({ ...input, ...matrix, ...patch });
  const updateDimension = (index: number, patch: Partial<Dimension>) => update({ dimensions: matrix.dimensions.map((dimension, at) => at === index ? { ...dimension, ...patch } : dimension) });
  const updateOption = (index: number, patch: Partial<Option>) => update({ options: matrix.options.map((option, at) => at === index ? { ...option, ...patch } : option) });
  return <div className="eng-matrix-input" role="group" aria-label="比较矩阵内容">
    <div className="eng-section-heading"><h3>比较矩阵内容</h3><span>{matrix.options.length} 个方案 · {matrix.dimensions.length} 个维度</span></div>
    <p className="eng-muted">用相同的维度比较方案。请填写已有依据的资料；没有数值时可以写有来源的文字说明。</p>
    {errors.length > 0 ? <div className="eng-notice eng-matrix-validation" role="status"><strong>比较内容尚未完整，保存和执行前需补充 {errors.length} 项。</strong><ul>{errors.slice(0, 5).map((error, index) => <li key={index}>{error}</li>)}</ul>{errors.length > 5 && <p>其余 {errors.length - 5} 项请查看下方标记的字段。</p>}</div> : <p className="eng-success-text">比较内容已填写完整，可以保存方案。</p>}
    <label>比较题目<input aria-label="比较题目" value={matrix.title} required maxLength={300} aria-invalid={!matrix.title.trim()} placeholder="这次要比较什么？" onChange={(event) => update({ title: event.target.value })} /></label>
    <label>适用场景<select aria-label="比较适用场景" value={matrix.fit_context} onChange={(event) => update({ fit_context: event.target.value })}><option value="">请选择场景</option>{Object.entries(scenarios).map(([value, label]) => <option key={value} value={value}>{label}</option>)}{matrix.fit_context && !(Object.hasOwn(scenarios, matrix.fit_context)) && <option value={matrix.fit_context}>当前场景不适用，请重新选择</option>}</select></label>
    <div className="eng-matrix-section-title"><h4>比较维度</h4><button type="button" disabled={matrix.dimensions.length >= 20} onClick={() => { const id = newId("dimension"); update({ dimensions: [...matrix.dimensions, { id, label: "", unit: "", source: "" }], options: matrix.options.map((option) => ({ ...option, values: { ...option.values, [id]: "" } })) }); }}>＋ 添加比较维度</button></div>
    {matrix.dimensions.map((dimension, index) => <div className="eng-matrix-dimension" key={`${dimension.id}-${index}`} role="group" aria-label={`比较维度 ${index + 1}`}>
      <div className="eng-item-heading"><strong>维度 {index + 1}</strong><button type="button" disabled={matrix.dimensions.length <= 1} aria-label={`移除比较维度 ${index + 1}`} onClick={() => update({ dimensions: matrix.dimensions.filter((_, at) => at !== index), options: matrix.options.map((option) => ({ ...option, values: Object.fromEntries(Object.entries(option.values).filter(([id]) => id !== dimension.id)) })) })}>移除</button></div>
      <div className="eng-field-row"><label>维度名称<input aria-label={`维度 ${index + 1} 名称`} required maxLength={300} aria-invalid={!dimension.label.trim()} value={dimension.label} placeholder="填写需要比较的项目" onChange={(event) => updateDimension(index, { label: event.target.value })} /></label><label>单位<input aria-label={`维度 ${index + 1} 单位`} required maxLength={300} aria-invalid={!dimension.unit.trim()} value={dimension.unit} placeholder="如：个、天；文字比较填“文字说明”" onChange={(event) => updateDimension(index, { unit: event.target.value })} /></label></div>
      <label>资料来源<input aria-label={`维度 ${index + 1} 来源`} required maxLength={1000} aria-invalid={!dimension.source.trim()} value={dimension.source} placeholder="写明资料名称、提供者或可核对的出处" onChange={(event) => updateDimension(index, { source: event.target.value })} /></label>
    </div>)}
    <div className="eng-matrix-section-title"><h4>待比较的方案</h4><button type="button" disabled={matrix.options.length >= 6} onClick={() => update({ options: [...matrix.options, { id: newId("option"), label: "", values: Object.fromEntries(matrix.dimensions.map((dimension) => [dimension.id, ""])) }] })}>＋ 添加比较方案</button></div>
    {matrix.options.map((option, index) => <div className="eng-matrix-option" key={`${option.id}-${index}`} role="group" aria-label={`比较方案 ${index + 1}`}>
      <div className="eng-item-heading"><strong>方案 {index + 1}</strong><button type="button" aria-label={`移除比较方案 ${index + 1}`} disabled={matrix.options.length <= 2} onClick={() => update({ options: matrix.options.filter((_, at) => at !== index) })}>移除</button></div>
      <label>方案名称<input aria-label={`方案 ${index + 1} 名称`} required maxLength={300} aria-invalid={!option.label.trim()} value={option.label} placeholder="填写这个方案的名称" onChange={(event) => updateOption(index, { label: event.target.value })} /></label>
      {matrix.dimensions.map((dimension, dimensionIndex) => { const value = option.values[dimension.id]; const missing = value === undefined || typeof value === "string" && !value.trim(); return <label key={`${dimension.id}-${dimensionIndex}`}>{dimension.label || `维度 ${dimensionIndex + 1}`}的比较值{dimension.unit ? `（${dimension.unit}）` : ""}<input aria-label={`方案 ${index + 1} 维度 ${dimensionIndex + 1} 比较值`} required maxLength={2000} aria-invalid={missing} value={value === undefined ? "" : String(value)} placeholder="填写有依据的数值或说明" onChange={(event) => updateOption(index, { values: { ...option.values, [dimension.id]: event.target.value } })} /><small>来源：{dimension.source || "请先填写该维度的资料来源"}</small></label>; })}
    </div>)}
  </div>;
}
