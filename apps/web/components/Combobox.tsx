'use client';

import { useRef } from 'react';

export interface ComboboxOption {
  /** 选中后写入表单的值 */
  value: string;
  /** 下拉中展示的辅助文本（如 中文名 / 英文名），不参与匹配筛选 */
  label?: string;
}

/**
 * 可输入筛选的下拉框：原生 <input> + <datalist> 实现。
 * - 可直接点击下拉选择候选项
 * - 也可输入关键字，浏览器自动按输入内容筛选匹配项
 * 用于导师（来自用户管理）、关联学生等需要「选择或手输」的字段。
 */
export default function Combobox({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
}) {
  const id = useRef(`cb-${Math.random().toString(36).slice(2)}`).current;
  return (
    <>
      <input
        className="form-input"
        list={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={id}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label ?? ''}</option>
        ))}
      </datalist>
    </>
  );
}
