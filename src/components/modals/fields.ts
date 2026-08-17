/**
 * Costruzione dei campi dei modal.
 *
 * discord.js 14.27 ha spostato l'etichetta dal `TextInputBuilder` a un
 * `LabelBuilder` che lo avvolge (`TextInputBuilder.setLabel` e
 * `ModalBuilder.addComponents` sono deprecati). Questo helper concentra la
 * nuova forma in un punto solo, così i modal restano leggibili.
 */
import { LabelBuilder, TextInputBuilder, type TextInputStyle } from 'discord.js';

export interface TextFieldOptions {
  readonly customId: string;
  readonly label: string;
  /** Testo secondario sotto l'etichetta. */
  readonly description?: string;
  readonly style: TextInputStyle;
  readonly placeholder?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly required?: boolean;
  readonly value?: string;
}

export function textField(options: TextFieldOptions): LabelBuilder {
  const input = new TextInputBuilder().setCustomId(options.customId).setStyle(options.style);

  if (options.placeholder !== undefined) input.setPlaceholder(options.placeholder);
  if (options.minLength !== undefined) input.setMinLength(options.minLength);
  if (options.maxLength !== undefined) input.setMaxLength(options.maxLength);
  if (options.value !== undefined && options.value !== '') input.setValue(options.value);
  input.setRequired(options.required ?? true);

  const label = new LabelBuilder().setLabel(options.label).setTextInputComponent(input);
  if (options.description !== undefined) label.setDescription(options.description);

  return label;
}
