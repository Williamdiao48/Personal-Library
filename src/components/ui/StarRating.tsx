import { useState, useId } from 'react'

interface Props {
  value: number | null
  onChange?: (v: number | null) => void
  size?: number
}

const STAR_PATH =
  'M10 1L12.24 7.28H19L13.38 11.22L15.62 17.5L10 13.56L4.38 17.5L6.62 11.22L1 7.28H7.76Z'

function StarSvg({
  size,
  fill,
  clipId,
}: {
  size: number
  fill: 'full' | 'half' | 'empty'
  clipId: string
}) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      style={{ display: 'block', pointerEvents: 'none' }}
    >
      {fill === 'half' && (
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y="0" width="10" height="20" />
          </clipPath>
        </defs>
      )}
      <path d={STAR_PATH} className="star-path-empty" />
      {fill !== 'empty' && (
        <path
          d={STAR_PATH}
          className="star-path-filled"
          clipPath={fill === 'half' ? `url(#${clipId})` : undefined}
        />
      )}
    </svg>
  )
}

export default function StarRating({ value, onChange, size = 16 }: Props) {
  const [hovered, setHovered] = useState<number | null>(null)
  const uid = useId()
  const displayed = hovered ?? value

  return (
    <div className="star-rating" onMouseLeave={() => onChange && setHovered(null)}>
      {[1, 2, 3, 4, 5].map((star) => {
        const full = displayed != null && displayed >= star
        const half = displayed != null && displayed >= star - 0.5 && displayed < star
        const fill: 'full' | 'half' | 'empty' = full ? 'full' : half ? 'half' : 'empty'
        return (
          <div key={star} className="star-item" style={{ width: size, height: size }}>
            <StarSvg size={size} fill={fill} clipId={`${uid}-s${star}`} />
            {onChange && (
              <>
                <button
                  className="star-half star-half--left"
                  onMouseEnter={() => setHovered(star - 0.5)}
                  onClick={(e) => {
                    e.stopPropagation()
                    onChange(value === star - 0.5 ? null : star - 0.5)
                  }}
                  aria-label={`Rate ${star - 0.5} stars`}
                />
                <button
                  className="star-half star-half--right"
                  onMouseEnter={() => setHovered(star)}
                  onClick={(e) => {
                    e.stopPropagation()
                    onChange(value === star ? null : star)
                  }}
                  aria-label={`Rate ${star} stars`}
                />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
