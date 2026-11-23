/** Hob card JSON 2.0 subset shared by the server and web client. */

export type CardText = string | { tag: "plain_text" | "lark_md"; content: string };
export type CardButtonType = "primary_filled" | "default" | "danger";
export type CardInputType = "text" | "multiline_text" | "password" | "number";
export type CardBehavior =
  | { type: "callback"; value?: Record<string, unknown> }
  | { type: "open_url"; default_url: string };

export interface CardConfirm {
  title: CardText;
  text: CardText;
}

export interface CardElementBase {
  tag: string;
  element_id?: string;
}

export interface CardMarkdown extends CardElementBase {
  tag: "markdown";
  content: CardText;
}

export interface CardDiv extends CardElementBase {
  tag: "div";
  text: CardText;
}

export interface CardHr extends CardElementBase {
  tag: "hr";
}

export interface CardImg extends CardElementBase {
  tag: "img";
  src: string;
  alt: CardText;
}

export interface CardTableColumn {
  name: string;
  display_name: CardText;
}

export interface CardTable extends CardElementBase {
  tag: "table";
  columns: CardTableColumn[];
  rows: Record<string, unknown>[];
}

export interface CardForm extends CardElementBase {
  tag: "form";
  name: string;
  elements: CardElement[];
}

export interface CardColumn {
  weight: number;
  elements: CardElement[];
}

export interface CardColumnSet extends CardElementBase {
  tag: "column_set";
  columns: CardColumn[];
  background_style?: string;
}

export interface CardCollapsiblePanel extends CardElementBase {
  tag: "collapsible_panel";
  header: { title: CardText | { content: CardText } };
  expanded?: boolean;
  elements: CardElement[];
}

export interface CardInteractiveContainer extends CardElementBase {
  tag: "interactive_container";
  elements: CardElement[];
  background_style?: string;
  behaviors?: CardBehavior[];
}

export interface CardInput extends CardElementBase {
  tag: "input";
  name?: string;
  label?: CardText;
  placeholder?: CardText;
  default_value?: string | number;
  required?: boolean;
  max_length?: number;
  min_length?: number;
  min?: number;
  max?: number;
  input_type?: CardInputType;
  generate?: boolean;
}

export interface CardSelectOption {
  text: CardText;
  value: string;
}

export interface CardSelectStatic extends CardElementBase {
  tag: "select_static";
  name?: string;
  label?: CardText;
  options: CardSelectOption[];
  initial_option?: string;
  placeholder?: CardText;
  required?: boolean;
}

export interface CardMultiSelectStatic extends CardElementBase {
  tag: "multi_select_static";
  name?: string;
  label?: CardText;
  options: CardSelectOption[];
  initial_options?: string[];
  placeholder?: CardText;
  required?: boolean;
}

export interface CardDatePicker extends CardElementBase {
  tag: "date_picker";
  name?: string;
  label?: CardText;
  initial_date?: string;
  required?: boolean;
}

export interface CardTimePicker extends CardElementBase {
  tag: "picker_time";
  name?: string;
  label?: CardText;
  initial_time?: string;
  required?: boolean;
}

export interface CardDateTimePicker extends CardElementBase {
  tag: "picker_datetime";
  name?: string;
  label?: CardText;
  initial_datetime?: string;
  required?: boolean;
}

export interface CardChecker extends CardElementBase {
  tag: "checker";
  name?: string;
  text: CardText;
  checked?: boolean;
}

export interface CardButton extends CardElementBase {
  tag: "button";
  text: CardText;
  type?: CardButtonType;
  form_action_type?: "submit" | "reset";
  behaviors?: CardBehavior[];
  confirm?: CardConfirm;
}

export interface CardOverflowOption {
  text: CardText;
  value: string;
}

export interface CardOverflow extends CardElementBase {
  tag: "overflow";
  name?: string;
  label?: CardText;
  options: CardOverflowOption[];
}

export type CardElement =
  | CardMarkdown
  | CardDiv
  | CardHr
  | CardImg
  | CardTable
  | CardForm
  | CardColumnSet
  | CardCollapsiblePanel
  | CardInteractiveContainer
  | CardInput
  | CardSelectStatic
  | CardMultiSelectStatic
  | CardDatePicker
  | CardTimePicker
  | CardDateTimePicker
  | CardChecker
  | CardButton
  | CardOverflow;

export interface CardHeader {
  title: CardText | { content: CardText };
  subtitle?: CardText | { content: CardText };
}

export interface Card {
  schema?: "2.0";
  config?: { summary?: { content: CardText } };
  header?: CardHeader;
  body: { elements: CardElement[] };
}

export type CardValidationMode = "assistant" | "plugin";

export interface ValidatedCard {
  card: Card;
  title: string;
  interactive: boolean;
  componentCount: number;
  unsupportedCount: number;
}

export interface CardValidationError {
  error: string;
  path?: string;
}

export type CardValidationResult =
  | { ok: true; value: ValidatedCard }
  | { ok: false; error: CardValidationError };

export interface CardOwnerAssistant {
  type: "assistant";
  assistantId: string;
}

export interface CardOwnerPlugin {
  type: "plugin";
  pluginId: string;
  assistantId: string;
}

export type CardOwner = CardOwnerAssistant | CardOwnerPlugin;

export interface CardRecord {
  id: string;
  owner: CardOwner;
  groupId?: string;
  card: Card;
  status: "open" | "done";
  result?: CardActionResult;
  createdAt: string;
  updatedAt?: string;
}

export interface CardActionResult {
  action: Record<string, unknown>;
  buttonText?: string;
  fields?: Record<string, unknown>;
}

export interface CardActionRequest {
  action: Record<string, unknown>;
  form_value?: Record<string, unknown>;
  button_text?: string;
}
