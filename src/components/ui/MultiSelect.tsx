import { useRef } from 'react'
import {
  Listbox,
  ListboxButton,
  ListboxOptions,
  ListboxOption,
} from '@headlessui/react'
import type { SelectOption } from './CustomSelect'

interface Props {
  label:    string
  options:  SelectOption[]
  values:   string[]
  onChange: (values: string[]) => void
}

export default function MultiSelect({ label, options, values, onChange }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)

  function blurTrigger() {
    setTimeout(() => triggerRef.current?.blur(), 0)
  }

  function handleTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Escape') blurTrigger()
  }

  let triggerText = 'All'
  if (values.length === 1) {
    triggerText = options.find(o => o.value === values[0])?.label ?? 'All'
  } else if (values.length > 1) {
    triggerText = `${values.length} selected`
  }

  const singleColor = values.length === 1
    ? options.find(o => o.value === values[0])?.color
    : undefined

  return (
    <div className="custom-select-wrapper">
      {label && <span className="custom-select-label" aria-hidden="true">{label}</span>}

      <Listbox value={values} onChange={onChange} multiple>
        {({ open }) => (
          <div className="custom-select">
            {open && (
              <div
                className="custom-select-backdrop"
                aria-hidden="true"
                onMouseDown={e => {
                  e.preventDefault()
                  triggerRef.current?.click()
                  blurTrigger()
                }}
              />
            )}

            <ListboxButton
              ref={triggerRef}
              className={`custom-select-trigger${open ? ' open' : ''}`}
              aria-label={`${label}: ${triggerText}`}
              onKeyDown={handleTriggerKeyDown}
            >
              {singleColor && (
                <span
                  className="custom-select-dot"
                  style={{ backgroundColor: singleColor }}
                  aria-hidden="true"
                />
              )}
              <span className="custom-select-trigger-text">{triggerText}</span>
              <svg
                className={`custom-select-chevron${open ? ' open' : ''}`}
                aria-hidden="true"
                viewBox="0 0 12 12"
                width="12"
                height="12"
              >
                <path
                  d="M2 4l4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </ListboxButton>

            <ListboxOptions
              anchor="bottom start"
              className="custom-select-options"
            >
              {options.map(opt => (
                <ListboxOption
                  key={opt.value}
                  value={opt.value}
                  className={({ focus, selected: sel }) =>
                    [
                      'custom-select-option',
                      focus ? 'focused'  : '',
                      sel   ? 'selected' : '',
                    ].filter(Boolean).join(' ')
                  }
                >
                  {({ selected: sel }) => (
                    <>
                      {opt.color && (
                        <span
                          className="custom-select-dot"
                          style={{ backgroundColor: opt.color }}
                          aria-hidden="true"
                        />
                      )}
                      <span className="custom-select-option-label">{opt.label}</span>
                      {sel && (
                        <svg
                          className="custom-select-check"
                          aria-hidden="true"
                          viewBox="0 0 12 12"
                          width="12"
                          height="12"
                        >
                          <path
                            d="M2 6l3 3 5-5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </>
                  )}
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        )}
      </Listbox>
    </div>
  )
}
