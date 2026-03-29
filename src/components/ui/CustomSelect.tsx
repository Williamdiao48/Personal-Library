import { useRef } from 'react'
import {
  Listbox,
  ListboxButton,
  ListboxOptions,
  ListboxOption,
} from '@headlessui/react'

export interface SelectOption {
  value: string
  label: string
  color?: string
}

interface Props {
  label:               string
  options:             SelectOption[]
  value:               string
  onChange:            (value: string) => void
  includePlaceholder?: boolean
  placeholder?:        string
}

export default function CustomSelect({
  label,
  options,
  value,
  onChange,
  includePlaceholder = true,
  placeholder = 'All',
}: Props) {
  const displayOptions: SelectOption[] = includePlaceholder
    ? [{ value: '', label: placeholder }, ...options]
    : options

  const selected   = displayOptions.find(o => o.value === value) ?? displayOptions[0]
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Remove focus ring after any close so the trigger doesn't stay highlighted.
  // setTimeout(0) lets Headless UI finish its own close bookkeeping first.
  function blurTrigger() {
    setTimeout(() => triggerRef.current?.blur(), 0)
  }

  function handleChange(val: string) {
    onChange(val)
    blurTrigger() // option selected → close → blur
  }

  function handleTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Escape') blurTrigger() // Escape → close → blur
  }

  return (
    <div className="custom-select-wrapper">
      {label && <span className="custom-select-label" aria-hidden="true">{label}</span>}

      <Listbox value={value} onChange={handleChange}>
        {({ open }) => (
          <div className="custom-select">

            {/* Full-screen backdrop when the dropdown is open.
                Catches clicks anywhere — including Electron's -webkit-app-region:drag
                areas like the sidebar — which the normal click-outside handler misses. */}
            {open && (
              <div
                className="custom-select-backdrop"
                aria-hidden="true"
                onMouseDown={e => {
                  e.preventDefault()          // keep focus on trigger; we'll blur manually
                  triggerRef.current?.click() // toggle-close the listbox
                  blurTrigger()
                }}
              />
            )}

            <ListboxButton
              ref={triggerRef}
              className={`custom-select-trigger${open ? ' open' : ''}`}
              aria-label={`${label}: ${selected.label}`}
              onKeyDown={handleTriggerKeyDown}
            >
              {selected.color && (
                <span
                  className="custom-select-dot"
                  style={{ backgroundColor: selected.color }}
                  aria-hidden="true"
                />
              )}
              <span className="custom-select-trigger-text">{selected.label}</span>
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
              {displayOptions.map(opt => (
                <ListboxOption
                  key={opt.value === '' ? '__placeholder__' : opt.value}
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
