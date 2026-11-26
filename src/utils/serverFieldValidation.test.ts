import { effectScope, reactive, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ApiFieldError } from '@/services/http';
import { useBoundServerFields } from './serverFieldValidation';
import { rejectFormSubmission } from './submitValidation';

vi.mock('./submitValidation', () => ({ rejectFormSubmission: vi.fn().mockResolvedValue(false) }));

function form() {
  const scope = effectScope();
  const active = ref(true);
  const values = reactive({ name: '芬迪白', remark: '原备注' });
  const root = ref({});
  const feedback = scope.run(() => useBoundServerFields(active, root, () => ({ ...values })))!;
  return { active, values, root, feedback, scope };
}
const duplicate = new ApiFieldError('name', '品种名称已存在');

describe('服务端字段错误', () => {
  afterEach(() => vi.clearAllMocks());
  it('一次展示多个有效字段，编辑其中一个后仅清除该字段', async () => {
    const { values, feedback, scope } = form();
    const error = new ApiFieldError('name', duplicate.message, undefined, [
      ...duplicate.fields, { field: 'name', message: '重复报告' }, { field: 'remark', message: '备注不能超过100字' },
    ]);
    expect(await feedback.begin()(error)).toBe(true);
    expect(rejectFormSubmission).toHaveBeenCalledTimes(1);
    expect(feedback.field('name').tips).toBe('品种名称已存在');
    expect(feedback.field('remark').tips).toBe('备注不能超过100字');
    values.name = '芬迪白新品';
    values.name = '芬迪白';
    expect(feedback.field('name').status).toBeUndefined();
    expect(feedback.field('remark').status).toBe('error');
    scope.stop();
  });
  it('用户已修改、重新打开或重新提交时忽略过期响应', async () => {
    const { active, values, feedback, scope } = form();
    const changed = feedback.begin();
    values.name = '新名称';
    expect(await changed(duplicate)).toBe(true);
    const reopened = feedback.begin();
    active.value = false;
    active.value = true;
    expect(await reopened(duplicate)).toBe(true);
    const previous = feedback.begin();
    feedback.begin();
    expect(await previous(duplicate)).toBe(true);
    expect(feedback.field('name').status).toBeUndefined();
    expect(rejectFormSubmission).not.toHaveBeenCalled();
    scope.stop();
  });
  it('无可编辑控件的失败保留原操作提示', async () => {
    const { feedback, scope } = form();
    const report = feedback.begin();
    expect(await report(new ApiError('当前操作不可用', 403))).toBe(false);
    expect(await report(new ApiFieldError('lockedId', '引用已失效'))).toBe(false);
    expect(rejectFormSubmission).not.toHaveBeenCalled();
    scope.stop();
  });
});
