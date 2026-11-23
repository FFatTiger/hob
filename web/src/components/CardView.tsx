import { t } from "../../../shared/i18n.ts";
import { useEffect, useState } from "react";
import type { CardElement, CardRecord } from "../../../shared/types.ts";
import type { CardActionRequest } from "../../../shared/cards.ts";
import { answerCard } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { Icon } from "../icons.tsx";

function cardText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value) && "content" in value) return cardText((value as { content?: unknown }).content);
  return "";
}

function cardElementChildren(element: any): CardElement[] {
  if (element.tag === "form" || element.tag === "collapsible_panel" || element.tag === "interactive_container") return element.elements ?? [];
  if (element.tag === "column_set") return (element.columns ?? []).flatMap((column: any) => column.elements ?? []);
  return [];
}

function cardLabel(element: any): string {
  return cardText(element.label) || cardText(element.text) || element.name || "";
}

function CardValue({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === "") return <span className="hc-empty">{t("（没填）")}</span>;
  if (typeof value === "boolean") return <span>{value ? t("开") : t("关")}</span>;
  if (Array.isArray(value)) return <span>{value.join("、")}</span>;
  return <span>{String(value)}</span>;
}

function initialValues(card: CardRecord["card"]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const visit = (elements: any[]) => {
    for (const element of elements) {
      if (typeof element.name === "string") {
        if (element.tag === "input" && element.default_value !== undefined) values[element.name] = element.default_value;
        if (element.tag === "select_static" && element.initial_option !== undefined) values[element.name] = element.initial_option;
        if (element.tag === "multi_select_static" && Array.isArray(element.initial_options)) values[element.name] = [...element.initial_options];
        if (["date_picker", "picker_time", "picker_datetime"].includes(element.tag)) values[element.name] = element.initial_date ?? element.initial_time ?? element.initial_datetime ?? "";
        if (element.tag === "checker" && element.checked !== undefined) values[element.name] = element.checked;
      }
      visit(cardElementChildren(element));
    }
  };
  visit(card.body.elements);
  return values;
}

function hasPassword(card: CardRecord["card"]): boolean {
  const visit = (elements: any[]): boolean => elements.some((element) => (element.tag === "input" && element.input_type === "password") || visit(cardElementChildren(element)));
  return visit(card.body.elements);
}

function validateElements(elements: any[], values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  const visit = (children: any[]) => {
    for (const element of children) {
      if (typeof element.name === "string") {
        const value = values[element.name];
        const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
        if (element.required && empty) errors[element.name] = t("这是必填项");
        const length = typeof value === "string" ? [...value].length : 0;
        if (!empty && element.min_length !== undefined && length < element.min_length) errors[element.name] = t("至少 {count} 个字", { count: element.min_length });
        if (!empty && element.max_length !== undefined && length > element.max_length) errors[element.name] = t("最多 {count} 个字", { count: element.max_length });
        if (!empty && element.input_type === "number" && typeof value === "number") {
          if (element.min !== undefined && value < element.min) errors[element.name] = t("不能小于 {value}", { value: element.min });
          if (element.max !== undefined && value > element.max) errors[element.name] = t("不能大于 {value}", { value: element.max });
        }
      }
      visit(cardElementChildren(element));
    }
  };
  visit(elements);
  return errors;
}

function CardResult({ record }: { record: CardRecord }) {
  const result = record.result;
  if (!result) return null;
  const fields = Object.entries(result.fields ?? {});
  return <div className="hc-result-list">
    {result.buttonText ? <div className="hc-result-row"><span>{t("操作")}</span><b>{result.buttonText}</b></div> : null}
    {fields.map(([key, value]) => <div className="hc-result-row" key={key}><span>{key}</span><b><CardValue value={value} /></b></div>)}
  </div>;
}

function generatedPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function CardInputControl({ element, value, onChange, disabled }: { element: any; value: unknown; onChange: (value: unknown) => void; disabled: boolean }) {
  const [show, setShow] = useState(false);
  const text = value === undefined ? "" : String(value);
  if (element.tag === "checker") return <label className="hc-checker"><span>{cardLabel(element)}</span><input type="checkbox" checked={Boolean(value ?? element.checked)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /></label>;
  if (element.tag === "select_static" || element.tag === "multi_select_static") {
    const options = element.options ?? [];
    const compact = options.length <= (element.tag === "select_static" ? 5 : 8) && options.every((option: any) => cardText(option.text).length <= 8);
    const selected = element.tag === "multi_select_static" ? (Array.isArray(value) ? value.map(String) : []) : String(value ?? "");
    const pick = (optionValue: string) => {
      if (element.tag === "multi_select_static") {
        const next = new Set(selected);
        if (next.has(optionValue)) next.delete(optionValue); else next.add(optionValue);
        onChange([...next]);
      } else onChange(optionValue);
    };
    if (compact) return <div className="hc-options">{options.map((option: any) => { const active = Array.isArray(selected) ? selected.includes(option.value) : selected === option.value; return <button type="button" className={`hc-option${active ? " active" : ""}`} disabled={disabled} aria-pressed={active} onClick={() => pick(option.value)} key={option.value}>{active && element.tag === "multi_select_static" ? <b>✓</b> : null}{cardText(option.text)}</button>; })}</div>;
    return <select className="hc-select" disabled={disabled} multiple={element.tag === "multi_select_static"} value={Array.isArray(selected) ? selected : selected} onChange={(event) => onChange(element.tag === "multi_select_static" ? [...event.target.selectedOptions].map((option) => option.value) : event.target.value)}>
      {!element.required && element.tag === "select_static" ? <option value="">{cardText(element.placeholder) || t("请选择")}</option> : null}
      {options.map((option: any) => <option value={option.value} key={option.value}>{cardText(option.text)}</option>)}
    </select>;
  }
  if (element.tag === "date_picker") return <input className="hc-input" type="date" disabled={disabled} value={text} onChange={(event) => onChange(event.target.value)} />;
  if (element.tag === "picker_time") return <input className="hc-input" type="time" disabled={disabled} value={text} onChange={(event) => onChange(event.target.value)} />;
  if (element.tag === "picker_datetime") return <input className="hc-input" type="datetime-local" disabled={disabled} value={text} onChange={(event) => onChange(event.target.value)} />;
  if (element.tag === "overflow") return <select className="hc-select" disabled={disabled} value={text} onChange={(event) => onChange(event.target.value)}><option value="">⋯</option>{(element.options ?? []).map((option: any) => <option value={option.value} key={option.value}>{cardText(option.text)}</option>)}</select>;
  if (element.input_type === "number") return <span className="hc-number"><button type="button" disabled={disabled || (element.min !== undefined && Number(value || 0) <= element.min)} onClick={() => onChange(Math.max(element.min ?? -Infinity, Number(value || 0) - 1))}>−</button><input className="hc-input" disabled={disabled} type="number" value={text} min={element.min} max={element.max} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} /><button type="button" disabled={disabled || (element.max !== undefined && Number(value || 0) >= element.max)} onClick={() => onChange(Math.min(element.max ?? Infinity, Number(value || 0) + 1))}>＋</button></span>;
  if (element.input_type === "multiline_text") return <textarea className="hc-input hc-area" disabled={disabled} value={text} placeholder={cardText(element.placeholder)} maxLength={element.max_length} onChange={(event) => onChange(event.target.value)} />;
  const password = element.input_type === "password";
  return <span className="hc-input-wrap"><input className="hc-input" disabled={disabled} type={password && !show ? "password" : "text"} value={text} placeholder={cardText(element.placeholder)} maxLength={element.max_length} onChange={(event) => onChange(event.target.value)} />{password ? <button type="button" className="hc-eye" disabled={disabled} onClick={() => setShow((current) => !current)}>{show ? "◉" : "◎"}</button> : null}{password && element.generate ? <button type="button" className="hc-generate" disabled={disabled} onClick={() => onChange(generatedPassword())}>{t("生成")}</button> : null}</span>;
}

type Submit = (element?: any, formElements?: any[], directValue?: unknown) => void;

function actionFor(element: any, value?: unknown): Record<string, unknown> {
  const action: Record<string, unknown> = { tag: element.tag, ...(element.name ? { name: element.name } : {}) };
  if (element.tag === "checker") action.checked = Boolean(value);
  else if (["select_static", "date_picker", "picker_time", "picker_datetime", "overflow"].includes(element.tag)) action.option = value;
  else if (element.tag === "multi_select_static") action.options = Array.isArray(value) ? value : [];
  else if (value !== undefined) action.value = value;
  return action;
}

function CardElementView({ element, values, setValue, errors, disabled, submit, openUrl, formElements }: { element: any; values: Record<string, unknown>; setValue: (name: string, value: unknown) => void; errors: Record<string, string>; disabled: boolean; submit: Submit; openUrl: (url: string) => void; formElements?: any[] }) {
  const field = typeof element.name === "string" ? element.name : undefined;
  const interactive = ["input", "select_static", "multi_select_static", "date_picker", "picker_time", "picker_datetime", "checker", "overflow"].includes(element.tag);
  const inForm = Boolean(formElements);
  if (element.tag === "markdown") return <Markdown text={cardText(element.content)} />;
  if (element.tag === "div") return <div className="hc-div">{cardText(element.text)}</div>;
  if (element.tag === "hr") return <hr className="hc-hr" />;
  if (element.tag === "img") return <img className="hc-img" src={element.src} alt={cardText(element.alt)} />;
  if (element.tag === "table") return <div className="hc-table-wrap"><table className="hc-table"><thead><tr>{(element.columns ?? []).map((column: any) => <th key={column.name}>{cardText(column.display_name)}</th>)}</tr></thead><tbody>{(element.rows ?? []).map((row: any, index: number) => <tr key={index}>{(element.columns ?? []).map((column: any) => <td key={column.name}>{String(row[column.name] ?? "")}</td>)}</tr>)}</tbody></table></div>;
  if (element.tag === "form") return <form className="hc-form" onSubmit={(event) => { event.preventDefault(); submit(undefined, element.elements ?? []); }}>{(element.elements ?? []).map((child: any, index: number) => <CardElementView key={child.element_id ?? index} element={child} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={element.elements ?? []} />)}</form>;
  if (element.tag === "column_set") return <div className="hc-columns">{(element.columns ?? []).map((column: any, index: number) => <div className="hc-column" key={index}>{(column.elements ?? []).map((child: any, childIndex: number) => <CardElementView key={child.element_id ?? childIndex} element={child} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={formElements} />)}</div>)}</div>;
  if (element.tag === "collapsible_panel") return <details className="hc-collapse" open={element.expanded}><summary>{cardText(element.header?.title)}</summary>{(element.elements ?? []).map((child: any, index: number) => <CardElementView key={child.element_id ?? index} element={child} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={formElements} />)}</details>;
  if (element.tag === "interactive_container") return <div className="hc-interactive" onClick={() => element.behaviors?.find((behavior: any) => behavior.type === "open_url") && openUrl(element.behaviors.find((behavior: any) => behavior.type === "open_url").default_url)}>{(element.elements ?? []).map((child: any, index: number) => <CardElementView key={child.element_id ?? index} element={child} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={formElements} />)}</div>;
  if (element.tag === "button") return <button type="button" className={`hob-btn${element.type === "primary_filled" ? " hob-btn-primary" : element.type === "danger" ? " hob-btn-danger" : ""}`} disabled={disabled} onClick={(event) => { event.preventDefault(); const url = element.behaviors?.find((behavior: any) => behavior.type === "open_url")?.default_url; if (url) openUrl(url); else submit(element, formElements); }}>{cardText(element.text)}</button>;
  if (interactive && field) {
    const change = (value: unknown) => { setValue(field, value); if (!inForm) submit({ ...element, value: undefined }, undefined, value); };
    return <label className="hc-field"><span className="hc-label"><span>{cardLabel(element)}{element.required ? <b>*</b> : null}</span>{element.min_length !== undefined ? <span className="hc-aside">{t("至少 {count} 位", { count: element.min_length })}</span> : element.tag === "multi_select_static" ? <span className="hc-aside">{t("可多选")}</span> : null}</span><CardInputControl element={element} value={values[field]} onChange={change} disabled={disabled} />{errors[field] ? <span className="hc-error">{errors[field]}</span> : null}</label>;
  }
  return null;
}

export function CardView({ record, fresh, itemId }: { record: CardRecord; fresh: boolean; itemId: string }) {
  const plugin = record.owner.type === "plugin";
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(record.card));
  const [errors, setErrors] = useState<Record<string, string>>(record.feedback?.errors ?? {});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setErrors(record.feedback?.errors ?? {}); setValues(initialValues(record.card)); }, [record.card, record.feedback?.errors]);
  const title = cardText(record.card.header?.title) || t("未命名卡片");
  const disabled = busy || record.status === "done";
  const openUrl = (url: string) => { if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener"); };
  const submit: Submit = async (element, formElements, directValue) => {
    if (disabled) return;
    const validation = validateElements(formElements ?? (element ? [element] : []), values);
    if (Object.keys(validation).length) { setErrors((current) => ({ ...current, ...validation })); return; }
    if (element && directValue !== undefined) setValues((current) => ({ ...current, ...(element.name ? { [element.name]: directValue } : {}) }));
    const actionElement = element ?? { tag: "button" };
    const action = actionFor(actionElement, directValue);
    setBusy(true);
    await answerCard(record.id, { action, form_value: Object.keys(values).length ? { ...values, ...(element?.name && directValue !== undefined ? { [element.name]: directValue } : {}) } : undefined, button_text: element?.tag === "button" ? cardText(element.text) : undefined } as CardActionRequest);
    setBusy(false);
  };
  const elements = record.card.body.elements;
  return <div className={`hov${fresh ? " enter" : ""}`} data-item-id={itemId}><div className={`b q hc${plugin ? " hc-plugin" : ""}${disabled ? " hc-disabled" : ""}`}>
    {plugin ? <div className="hc-source"><Icon name="plugin" size={15} />{record.plugin?.pluginName ?? (record.owner.type === "plugin" ? record.owner.pluginId : t("插件"))}{hasPassword(record.card) ? <span className="hc-lock">🔒 {t("填写的内容只交给插件")}</span> : null}</div> : null}
    <div className="qt">{title}</div>
    {record.card.header?.subtitle ? <div className="qs">{cardText(record.card.header.subtitle)}</div> : null}
    {record.feedback?.unavailable ? <div className="hc-unavailable">{record.feedback.unavailable}</div> : null}
    {record.feedback?.toast ? <div className={`hc-toast ${record.feedback.toast.type}`}>{record.feedback.toast.content}</div> : null}
    {record.status === "done" ? <CardResult record={record} /> : <div className="hc-elements">{elements.map((element, index) => <CardElementView key={(element as any).element_id ?? index} element={element} values={values} setValue={(name, value) => { setValues((current) => ({ ...current, [name]: value })); setErrors((current) => { const next = { ...current }; delete next[name]; return next; }); }} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} />)}</div>}
    {busy ? <div className="hc-loading"><Icon name="spin" className="spin" size={14} />{t("处理中…")}</div> : null}
  </div></div>;
}
