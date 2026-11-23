import { t } from "../../../shared/i18n.ts";
import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";
import type { CardElement, CardRecord } from "../../../shared/types.ts";
import type { CardActionRequest } from "../../../shared/cards.ts";
import { answerCard } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { useMenu } from "./use-menu.ts";
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

function sourceIcon(pluginId: string | undefined) {
  if (pluginId === "github") return <Icon name="github" size={15} />;
  if (pluginId === "cloudflare") return <Icon name="globe" size={15} />;
  if (pluginId === "email") return <Icon name="mail" size={15} />;
  if (pluginId === "nas") return <Icon name="server" size={15} />;
  if (pluginId === "bitwarden") return <Icon name="lock" size={15} />;
  return <Icon name="plugin" size={15} />;
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
  const findLabel = (elements: any[], name: string): string | undefined => {
    for (const element of elements) {
      if (element.name === name) return cardLabel(element);
      const nested = cardElementChildren(element);
      const found = findLabel(nested, name);
      if (found) return found;
    }
    return undefined;
  };
  const fields = Object.entries(result.fields ?? {});
  return <div className="hc-result-list">
    {fields.map(([key, value]) => <div className="hc-result-row" key={key}><span>{findLabel(record.card.body.elements, key) ?? key}</span><b><CardValue value={value} /></b></div>)}
  </div>;
}

function formatDateValue(value: string): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const lang = globalThis.document?.documentElement.lang || globalThis.navigator?.language || "zh-CN";
  if (lang.toLowerCase().startsWith("zh")) {
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
    return t("{month} 月 {day} 日 {weekday}", { month: date.getMonth() + 1, day: date.getDate(), weekday });
  }
  return new Intl.DateTimeFormat(lang, { month: "short", day: "numeric", weekday: "short" }).format(date);
}

function CardMenuField({ element, value, onChange, disabled }: { element: any; value: unknown; onChange: (value: unknown) => void; disabled: boolean }) {
  const menu = useMenu();
  const multi = element.tag === "multi_select_static";
  const options = element.options ?? [];
  const selected: string[] | string = multi ? (Array.isArray(value) ? value.map(String) : []) : String(value ?? "");
  const labels = (Array.isArray(selected) ? selected : [selected]).map((item: string) => cardText(options.find((option: any) => option.value === item)?.text)).filter(Boolean);
  const label = labels.length ? labels.join("、") : cardText(element.placeholder) || "⋯";
  return <>
    <button type="button" className="hc-select-button" disabled={disabled} aria-expanded={menu.menu?.id === element.name} onClick={(event) => menu.toggle(element.name || element.tag, event.currentTarget)}><span>{label}</span><Icon name="down" size={15} /></button>
    {menu.menu ? createPortal(<div className="amenu hc-card-menu" ref={menu.box} role="menu">
      {options.map((option: any) => {
        const active = Array.isArray(selected) ? selected.includes(option.value) : selected === option.value;
        return <button type="button" role="menuitem" className={active ? "selected" : ""} key={option.value} onClick={() => {
          if (Array.isArray(selected)) onChange(active ? selected.filter((item: string) => item !== option.value) : [...selected, option.value]);
          else { onChange(option.value); menu.close(); }
        }}>{active ? <Icon name="check" size={14} /> : <span className="hc-menu-empty" />}{cardText(option.text)}</button>;
      })}
    </div>, document.body) : null}
  </>;
}

function CardDateControl({ element, value, onChange, disabled }: { element: any; value: unknown; onChange: (value: unknown) => void; disabled: boolean }) {
  const text = value === undefined ? "" : String(value);
  return <span className="hc-date"><span>{formatDateValue(text)}</span><Icon name="cal" size={15} /><input aria-label={cardLabel(element)} className="hc-date-native" type="date" disabled={disabled} value={text} onChange={(event) => onChange(event.target.value)} /></span>;
}

function CardTableValue({ value }: { value: unknown }) {
  const [checked, setChecked] = useState(typeof value === "boolean" ? value : false);
  if (typeof value === "boolean") return <button type="button" className={`hc-table-switch${checked ? " on" : ""}`} role="switch" aria-checked={checked} onClick={() => setChecked((current) => !current)}><span /></button>;
  if (value === undefined || value === null || value === "") return <span className="hc-empty">—</span>;
  return <span>{String(value)}</span>;
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
    if (compact) {
      const selected = element.tag === "multi_select_static" ? (Array.isArray(value) ? value.map(String) : []) : String(value ?? "");
      return <div className="hc-options">{options.map((option: any) => { const active = Array.isArray(selected) ? selected.includes(option.value) : selected === option.value; return <button type="button" className={`hc-option${active ? " active" : ""}`} disabled={disabled} aria-pressed={active} onClick={() => {
        if (Array.isArray(selected)) onChange(active ? selected.filter((item) => item !== option.value) : [...selected, option.value]);
        else onChange(option.value);
      }} key={option.value}>{active && element.tag === "multi_select_static" ? <Icon name="check" size={13} /> : null}{cardText(option.text)}</button>; })}</div>;
    }
    return <CardMenuField element={element} value={value} onChange={onChange} disabled={disabled} />;
  }
  if (element.tag === "overflow") return <CardMenuField element={element} value={value} onChange={onChange} disabled={disabled} />;
  if (["date_picker", "picker_time", "picker_datetime"].includes(element.tag)) return element.tag === "date_picker" ? <CardDateControl element={element} value={value} onChange={onChange} disabled={disabled} /> : <input className="hc-input" type={element.tag === "picker_time" ? "time" : "datetime-local"} disabled={disabled} value={text} onChange={(event) => onChange(event.target.value)} />;
  if (element.input_type === "number") return <span className="hc-number"><button type="button" disabled={disabled || (element.min !== undefined && Number(value || 0) <= element.min)} onClick={() => onChange(Math.max(element.min ?? -Infinity, Number(value || 0) - 1))}>−</button><input className="hc-input" disabled={disabled} type="number" value={text} min={element.min} max={element.max} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} /><button type="button" disabled={disabled || (element.max !== undefined && Number(value || 0) >= element.max)} onClick={() => onChange(Math.min(element.max ?? Infinity, Number(value || 0) + 1))}>＋</button></span>;
  if (element.input_type === "multiline_text") return <textarea className="hc-input hc-area" disabled={disabled} value={text} placeholder={cardText(element.placeholder)} maxLength={element.max_length} onChange={(event) => onChange(event.target.value)} />;
  if (element.tag === "input" && element.name === "to" && text.includes("<") && text.endsWith(">")) return <div className="hc-input hc-recipient"><span>{text}</span><Icon name="close" size={13} /></div>;
  const password = element.input_type === "password";
  return <span className="hc-input-wrap"><input className="hc-input" disabled={disabled} type={password && !show ? "password" : "text"} value={text} placeholder={cardText(element.placeholder)} maxLength={element.max_length} onChange={(event) => onChange(event.target.value)} />{password ? <button type="button" className="hc-eye" disabled={disabled} aria-label={t("显示密码")} onClick={() => setShow((current) => !current)}><Icon name="eye" size={16} /></button> : null}{password && element.generate ? <button type="button" className="hc-generate" disabled={disabled} onClick={() => onChange(generatedPassword())}>{t("生成")}</button> : null}</span>;
}

type Submit = (element?: any, formElements?: any[], directValue?: unknown) => void;

function CardElementList({ elements, values, setValue, errors, disabled, submit, openUrl, formElements }: { elements: any[]; values: Record<string, unknown>; setValue: (name: string, value: unknown) => void; errors: Record<string, string>; disabled: boolean; submit: Submit; openUrl: (url: string) => void; formElements?: any[] }) {
  const result: ReactNode[] = [];
  for (let index = 0; index < elements.length;) {
    if (elements[index]?.tag === "button") {
      const buttons: any[] = [];
      while (elements[index]?.tag === "button") buttons.push(elements[index++]);
      result.push(<div className="hc-actions" key={`actions-${index}`}>{buttons.map((element, buttonIndex) => <CardElementView key={element.element_id ?? buttonIndex} element={element} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={formElements} />)}</div>);
      continue;
    }
    const element = elements[index++];
    result.push(<CardElementView key={element.element_id ?? index} element={element} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={formElements} />);
  }
  return <>{result}</>;
}

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
  if (element.tag === "div") return element.icon ? <div className="hc-file-row"><Icon name={element.icon === "file" ? "file" : "doc"} size={15} /><span>{cardText(element.text)}</span></div> : <div className="hc-div">{cardText(element.text)}</div>;
  if (element.tag === "hr") return <hr className="hc-hr" />;
  if (element.tag === "img") return <img className="hc-img" src={element.src} alt={cardText(element.alt)} />;
  if (element.tag === "table") return <div className="hc-table-wrap"><table className="hc-table"><thead><tr>{(element.columns ?? []).map((column: any) => <th key={column.name}>{cardText(column.display_name)}</th>)}</tr></thead><tbody>{(element.rows ?? []).map((row: any, index: number) => <tr key={index}>{(element.columns ?? []).map((column: any) => <td key={column.name}><CardTableValue value={row[column.name]} /></td>)}</tr>)}</tbody></table></div>;
  if (element.tag === "form") return <form className="hc-form" onSubmit={(event) => { event.preventDefault(); submit(undefined, element.elements ?? []); }}><CardElementList elements={element.elements ?? []} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={element.elements ?? []} /></form>;
  if (element.tag === "column_set") return <div className="hc-columns">{(element.columns ?? []).map((column: any, index: number) => <div className="hc-column" key={index}>{(column.elements ?? []).map((child: any, childIndex: number) => <CardElementView key={child.element_id ?? childIndex} element={child} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={formElements} />)}</div>)}</div>;
  if (element.tag === "collapsible_panel") return <details className="hc-collapse" open={element.expanded}><summary>{cardText(element.header?.title)}</summary>{(element.elements ?? []).map((child: any, index: number) => <CardElementView key={child.element_id ?? index} element={child} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={formElements} />)}</details>;
  if (element.tag === "interactive_container") return <div className="hc-interactive" onClick={() => element.behaviors?.find((behavior: any) => behavior.type === "open_url") && openUrl(element.behaviors.find((behavior: any) => behavior.type === "open_url").default_url)}>{(element.elements ?? []).map((child: any, index: number) => <CardElementView key={child.element_id ?? index} element={child} values={values} setValue={setValue} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} formElements={formElements} />)}</div>;
  if (element.tag === "button") return <button type="button" className={`hob-btn${element.type === "primary_filled" ? " hob-btn-primary" : element.type === "danger" ? " hob-btn-danger" : ""}`} disabled={disabled} onClick={(event) => { event.preventDefault(); const url = element.behaviors?.find((behavior: any) => behavior.type === "open_url")?.default_url; if (url) openUrl(url); else submit(element, formElements); }}>{cardText(element.text)}</button>;
  if (interactive && field) {
    const change = (value: unknown) => { setValue(field, value); if (!inForm) submit({ ...element, value: undefined }, undefined, value); };
    return <label className={`hc-field${errors[field] ? " has-error" : ""}`}><span className="hc-label"><span>{cardLabel(element)}{element.required ? <b>*</b> : null}</span>{element.min_length !== undefined ? <span className="hc-aside">{t("至少 {count} 位", { count: element.min_length })}</span> : element.tag === "multi_select_static" ? <span className="hc-aside">{t("可多选")}</span> : null}</span><CardInputControl element={element} value={values[field]} onChange={change} disabled={disabled} />{errors[field] ? <span className="hc-error">{errors[field]}</span> : null}</label>;
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
    {plugin ? <div className="hc-source">{sourceIcon(record.owner.type === "plugin" ? record.owner.pluginId : undefined)}{record.plugin?.pluginName ?? (record.owner.type === "plugin" ? record.owner.pluginId : t("插件"))}{hasPassword(record.card) ? <span className="hc-lock"><Icon name="lock" size={13} />{t("填写的内容只交给 {plugin}", { plugin: record.plugin?.pluginName ?? t("插件") })}</span> : null}</div> : null}
    <div className="qt">{title}</div>
    {record.card.header?.subtitle ? <div className="qs">{cardText(record.card.header.subtitle)}</div> : null}
    {record.feedback?.unavailable ? <div className="hc-unavailable">{record.feedback.unavailable}</div> : null}
    {record.status === "done" ? <CardResult record={record} /> : <div className="hc-elements"><CardElementList elements={elements} values={values} setValue={(name, value) => { setValues((current) => ({ ...current, [name]: value })); setErrors((current) => { const next = { ...current }; delete next[name]; return next; }); }} errors={errors} disabled={disabled} submit={submit} openUrl={openUrl} /></div>}
    {record.feedback?.toast ? <div className={`hc-toast ${record.feedback.toast.type}`}>{record.feedback.toast.content}</div> : null}
    {busy ? <div className="hc-loading"><Icon name="spin" className="spin" size={14} />{t("处理中…")}</div> : null}
  </div></div>;
}
