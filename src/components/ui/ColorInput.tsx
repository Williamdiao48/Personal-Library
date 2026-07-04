import { useRef } from 'react'

interface Props {
  value: string
  onChange: (color: string) => void
  size?: number
}

export default function ColorInput({ value, onChange, size = 28 }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <label className="color-input-trigger" style={{ width: size, height: size }} title="Pick color">
      <span
        className="color-input-circle"
        style={{ backgroundColor: value, width: size, height: size }}
      />
      <input
        ref={inputRef}
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="color-input-native"
      />
    </label>
  )
}
