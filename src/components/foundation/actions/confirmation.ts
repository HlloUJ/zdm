import type { ButtonProps } from 'tdesign-vue-next';
import { actionButtonProps, type ButtonFunction } from './buttonFunctions';
import registry from './button-functions.json';

export type ConfirmationButtonOptions = Omit<ButtonProps, 'content' | 'theme'> & { content?: never; theme?: never };

export type FormMode = 'create' | 'edit';
export type Confirmation =
  | { kind: 'form'; mode: FormMode }
  | { kind: 'operation'; action: keyof typeof registry.confirmationActions; batch: boolean }
  | { kind: 'close'; text: '关闭' | '我知道了' }
  | { kind: 'navigation'; action: keyof typeof registry.confirmationNavigation }
  | { kind: 'acknowledgement'; action: keyof typeof registry.confirmationAcknowledgements }
  | { kind: 'none' };

export function formConfirmation(mode: FormMode): Confirmation {
  if (mode !== 'create' && mode !== 'edit') throw new Error(`Unregistered form mode: ${mode}`);
  return { kind: 'form', mode };
}
export function operationConfirmation(action: string, batch = false): Confirmation {
  if (!Object.hasOwn(registry.confirmationActions, action))
    throw new Error(`Unregistered confirmation action: ${action}`);
  return { kind: 'operation', action: action as keyof typeof registry.confirmationActions, batch };
}
/** Describe the subject and direction separately from the footer button caption. */
export function confirmationQuestion(action: string, target: string, batch = false): string {
  const scope = batch || action.startsWith('批量') ? '批量' : '';
  const verb = action.replace(/^批量/, '');
  let phrase = `${verb}${target}`;
  if (target) {
    switch (verb) {
      case '放回':
      case '放回到仓库':
      case '放回仓库':
        phrase = `将${target}放回仓库`;
        break;
      case '删除至回收站':
        phrase = `将${target}移至回收站`;
        break;
      case '恢复运营':
        phrase = `恢复${target}运营`;
        break;
      case '取消归档':
        phrase = `取消${target}归档`;
        break;
      case '清空回收站':
        phrase = `清空${target}回收站`;
        break;
      case '保存价格':
        phrase = `保存${target}价格`;
        break;
      case '删除跟进记录':
        phrase = `删除${target}跟进记录`;
        break;
    }
  }
  return `是否${scope}${phrase}？`;
}

export function confirmationText(confirmation: Confirmation): string {
  switch (confirmation.kind) {
    case 'form':
      if (confirmation.mode !== 'create' && confirmation.mode !== 'edit')
        throw new Error(`Unregistered form mode: ${confirmation.mode}`);
      return confirmation.mode === 'create' ? '确认新增' : '确认保存';
    case 'operation': {
      const { action, batch } = confirmation;
      if (!Object.hasOwn(registry.confirmationActions, action))
        throw new Error(`Unregistered confirmation action: ${action}`);
      const name = registry.confirmationActions[action];
      return `确认${batch && !name.startsWith('批量') ? '批量' : ''}${name}`;
    }
    case 'close':
      if (!['关闭', '我知道了'].includes(confirmation.text)) throw new Error('Unregistered close caption');
      return confirmation.text;
    case 'navigation':
      if (!Object.hasOwn(registry.confirmationNavigation, confirmation.action))
        throw new Error('Unregistered confirmation navigation');
      return registry.confirmationNavigation[confirmation.action];
    case 'acknowledgement':
      if (!Object.hasOwn(registry.confirmationAcknowledgements, confirmation.action))
        throw new Error('Unregistered acknowledgement');
      return registry.confirmationAcknowledgements[confirmation.action];
    case 'none':
      return '';
    default:
      throw new Error('Missing or invalid confirmation registration');
  }
}
export function formConfirmationText(mode: FormMode): string {
  return confirmationText(formConfirmation(mode));
}
export function dialogButtonProps(
  fn: ButtonFunction,
  confirmation: Confirmation,
  original?: string | ButtonProps | null,
): ButtonProps | null {
  const content = confirmationText(confirmation);
  if (original === null || confirmation.kind === 'none') return null;
  return { ...actionButtonProps(fn, original), content };
}
