import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/** 密钥输入框：默认密文显示，点眼睛切换明文；已保存的值会回显在框里 */
export const SecretInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}> = ({ value, onChange, placeholder, className = '', autoFocus }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${className} pr-10 font-mono`}
        autoComplete="new-password"
        spellCheck={false}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-[#86868B] hover:text-[#1D1D1F] hover:bg-black/[0.04] cursor-pointer"
        title={show ? '隐藏' : '显示明文'}
        aria-label={show ? '隐藏' : '显示明文'}
      >
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
};
