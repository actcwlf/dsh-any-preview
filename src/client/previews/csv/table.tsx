/**
 * The table itself: a scroller holding either the exact rows or the pinned window, with
 * the header, the row numbers and the highlight. No state beyond the row box lives here.
 */
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { Marked } from '../../kernel/marks.tsx'
import { ACTIVE_ROW } from '../../kernel/layout.ts'
import { DATA_TABLE_HEADER } from '../../kernel/ui.ts'
import { toFileRow } from '../../kernel/row-numbering.ts'
import type { SearchOccurrence } from '../../kernel/search.ts'
import type { ProportionalGeometry, WindowedBody } from '../../kernel/window-state.ts'

/** Everything the table renders from. */
export interface CsvTableProps {
  /** Stable ref callback for the scroller (the owner restores its offset on attach). */
  readonly bindScroller: (element: HTMLDivElement | null) => void
  /** Scroll offset, mirrored into React so a window can be planned. */
  readonly onScroll: (top: number) => void
  /** Present only when the bar is proportional and the table is pinned. */
  readonly geometry: ProportionalGeometry | undefined
  /** Visible height, used to size the pinned block. */
  readonly viewportHeight: number
  readonly header: readonly string[]
  readonly columns: number
  /** Rows to paint plus the filler that holds the scrollbar's length. */
  readonly body: WindowedBody
  /** Scroll offset of the painted band inside the pinned block, when pinned. */
  readonly bandOffset: number | undefined
  readonly activeRow: number | undefined
  /** The one occurrence the navigation points at, if any. */
  readonly activeOccurrence: SearchOccurrence | undefined
  readonly pattern: RegExp | undefined
  /** True when the row numbers come from an estimate, so they carry a marker. */
  readonly estimated: boolean
  readonly rowHeight: number
}

/**
 * Render the scrollable table.
 * @param props - rows, geometry and the few flags that change how a row looks.
 */
export function CsvTable(props: CsvTableProps) {
  useLocale()
  const {
    bindScroller, onScroll, geometry, viewportHeight, header, columns, body, bandOffset,
    activeRow, activeOccurrence, pattern, estimated, rowHeight,
  } = props
  const lineBox = { lineHeight: `${String(rowHeight - 2)}px` } as const
  const indexCell = { ...indexStyle, ...lineBox }
  const bodyCell = { ...cellStyle, ...lineBox }
  const pinned = geometry !== undefined
  const pinnedBlock = pinned ? { position: 'sticky' as const, top: 0, height: viewportHeight } : undefined
  const content = pinned ? { height: geometry.contentHeight, position: 'relative' as const } : undefined

  return (
    <div
      ref={bindScroller}
      onScroll={event => onScroll(event.currentTarget.scrollTop)}
      // The pinned table changes under the browser's scroll anchoring; it must not
      // "correct" our offset behind our back.
      style={{ flex: '1 1 auto', overflow: 'auto', overflowAnchor: 'none' }}
    >
      <div style={content}>
        <div style={pinnedBlock}>
          <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--dsw-font-family)', fontSize: 12, whiteSpace: 'nowrap' }}>
            <thead>
              <tr>
                <th style={cornerStyle} />
                {header.map((value, column) => (
                  <th key={column} style={headerStyle}>{value || t('csv.column', { index: column + 1 })}</th>
                ))}
              </tr>
            </thead>
            <tbody style={bandOffset === undefined ? undefined : { transform: `translateY(${String(-bandOffset)}px)` }}>
              {body.topPad > 0 && (
                <tr style={{ height: body.topPad }}>
                  <td colSpan={columns + 1} style={spacerCell} />
                </tr>
              )}
              {body.rows.map((row) => {
                if (row.cells === null) {
                  return (
                    <tr key={row.index} style={{ height: rowHeight }}>
                      <td colSpan={columns + 1} style={spacerCell} />
                    </tr>
                  )
                }
                const active = row.index === activeRow
                return (
                  <tr
                    key={row.index}
                    data-row-index={row.index}
                    style={{ height: rowHeight, background: active ? ACTIVE_ROW : undefined }}
                  >
                    <td style={active ? activeIndexCell : indexCell}>
                      {estimated ? `~${String(toFileRow(row.index))}` : toFileRow(row.index)}
                    </td>
                    {row.cells.map((value, column) => (
                      <td key={column} style={bodyCell}>
                        <Marked
                          text={value}
                          pattern={pattern}
                          activeRange={activeOccurrence?.row === row.index && activeOccurrence.cell === column
                            ? { start: activeOccurrence.start, end: activeOccurrence.end }
                            : undefined}
                        />
                      </td>
                    ))}
                  </tr>
                )
              })}
              {body.bottomPad > 0 && (
                <tr style={{ height: body.bottomPad }}>
                  <td colSpan={columns + 1} style={spacerCell} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const headerStyle = {
  ...DATA_TABLE_HEADER,
  position: 'sticky' as const,
  top: 0,
  zIndex: 1,
  textAlign: 'left' as const,
  verticalAlign: 'middle' as const,
}

const cornerStyle = { ...headerStyle, left: 0, zIndex: 2, width: 1 }

const spacerCell = { padding: 0, border: 'none' } as const

const indexStyle = {
  padding: '0 10px',
  textAlign: 'right' as const,
  color: 'var(--dsw-alias-label-tertiary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
  position: 'sticky' as const,
  left: 0,
  // Opaque, and the same surface as the rows: it slides under the header, so it cannot
  // be transparent, and a different colour would draw a strip down the pane.
  background: 'var(--dsw-alias-bg-base)',
  userSelect: 'none' as const,
} as const

const cellStyle = {
  padding: '0 16px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-label-primary)',
} as const

/**
 * The sticky row-number cell of the highlighted row.
 *
 * `ACTIVE_ROW` is a translucent wash, and this cell has to stay opaque so numbers do not
 * show through it when the table scrolls sideways: the wash goes on as an image layer
 * over the solid surface instead of being the background itself.
 */
const activeIndexCell = {
  ...indexStyle,
  backgroundImage: `linear-gradient(${ACTIVE_ROW}, ${ACTIVE_ROW})`,
} as const

