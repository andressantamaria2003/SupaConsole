"use client";

import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';

type PasswordFieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  id?: string;
  value: string;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
};

const PasswordField: React.FC<PasswordFieldProps> = ({ id, value, onChange, placeholder, className, ...rest }) => {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={className}
        {...rest}
      />
      <button
        type="button"
        aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
        tabIndex={0}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
};

export default PasswordField;