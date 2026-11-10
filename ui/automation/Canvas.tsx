import { HatGround, TablerIcon } from '@ein/ui/components';
import { usePanZoom } from '@ein/ui/hooks';
import { fitView, formatTime } from '@ein/ui/lib';
import { ActionIcon, Box, Stack, Text, Tooltip } from '@mantine/core';
import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AutomationNodeSpec, AutomationNodeStatus, AutomationProblem, AutomationSpec } from '../../lib/api.ts';
import { KINDS } from '../../lib/automations/catalog.ts';
import { connect, mayConnect, moveNode, outputsOf, takesInput, type Wire, wiresOf } from './graph-edit.ts';
import { agoText, CANVAS_PAD, FRESH_MS, inputY, NODE_WIDTH, nodeHeight, outputY, statusText, summaryOf, wireMiddle, wirePath, wireValue } from './node-view.ts';

export type Selection = { kind: 'node'; id: string } | { kind: 'wire'; wire: Wire };

type CanvasProps = {
  spec: AutomationSpec;
  editable: boolean;
  /** Whether a card may be dragged to a new place: while editing, and while simulating, which reads nothing of where cards stand. */
  movable?: boolean;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  onChange: (spec: AutomationSpec) => void;
  status?: Record<string, AutomationNodeStatus>;
  /** The time `status` is told against: a simulation's own, else the real one. */
  now?: number;
  problems: AutomationProblem[];
  /** Asks the canvas where a new node goes: the middle of what is in view. */
  placeRef?: { current: (() => [number, number]) | null };
  /** Picks where the tiling behind the drawing is cut, so each automation keeps its own. */
  seed: string;
  /** How much of the box's left and right edges is under panels: fitting and placing use the rest. */
  insets?: { left: number; right: number };
  /** Buttons of the page's, above the canvas's own in its corner. */
  tools?: ReactNode;
};

/** The room left round the nodes when they are fitted, clear of the panels' edges and handles. */
const FIT_MARGIN = 40;
/** How tall a card's coloured band is: its title's line and the padding above it. */
const CARD_BAND = 32;
/** How far a press moves before it is a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** Where a node lands when it is dropped: on a grid, so nodes line up. */
const SNAP = 10;
const snap = (n: number) => Math.round(n / SNAP) * SNAP;

/** A pressed element that is the canvas's own, not the drawing's to pan with. */
const OWN = '[data-pan-ignore]';

const posOf = (node: AutomationNodeSpec): [number, number] => node.pos ?? [0, 0];

const sameWire = (a: Wire, b: Wire) => a.from === b.from && a.output === b.output && a.to === b.to;

/**
 * An automation's graph, drawn: each node a card at its `pos`, its input on the left and its
 * outputs on the right, each wire a curve from an output to an input. The drawing is dragged and
 * zoomed as a map is (`usePanZoom`); a card is dragged to move it, an output dragged to a card wires
 * them, and a card or a wire tapped is selected. Read-only, it is only looked at.
 *
 * Nodes may stand anywhere, below zero too: the drawing is the box round them and some room, and
 * when it grows to the left or up the view moves with it, so nothing on screen jumps.
 */
export function Canvas(
  { spec, editable, movable = editable, selection, onSelect, onChange, status, now, problems, placeRef, seed, insets = { left: 0, right: 0 }, tools }: CanvasProps,
) {
  const entries = Object.entries(spec.nodes);
  const bounds = useMemo(() => {
    if (!entries.length) return { x: -CANVAS_PAD, y: -CANVAS_PAD, width: CANVAS_PAD * 2 + NODE_WIDTH, height: CANVAS_PAD * 2 + 64 };
    const xs = entries.map(([, node]) => posOf(node)[0]);
    const ys = entries.map(([, node]) => posOf(node)[1]);
    const x = Math.min(...xs) - CANVAS_PAD;
    const y = Math.min(...ys) - CANVAS_PAD;
    const right = Math.max(...entries.map(([, node]) => posOf(node)[0] + NODE_WIDTH)) + CANVAS_PAD;
    const bottom = Math.max(...entries.map(([, node]) => posOf(node)[1] + nodeHeight(node))) + CANVAS_PAD;
    return { x, y, width: right - x, height: bottom - y };
  }, [spec]);
  const content = { width: bounds.width, height: bounds.height };

  const panZoom = usePanZoom({
    content,
    minScale: () => 0.25,
    ignore: (target) => target.closest(OWN) !== null,
    onPress: (target) => {
      if (!(target instanceof Element && target.closest(OWN))) onSelect(null);
    },
  });
  const { size, view, setView } = panZoom;

  /** The nodes as large as fits, no larger than full size: the drawing's room round them is for dragging, not fitting. */
  const fitNodes = () => {
    const room = { width: Math.max(size.width - insets.left - insets.right - FIT_MARGIN * 2, NODE_WIDTH), height: Math.max(size.height - FIT_MARGIN * 2, 64) };
    const fitted = fitView({ width: content.width - CANVAS_PAD * 2, height: content.height - CANVAS_PAD * 2 }, room, 0.25);
    return { ...fitted, x: fitted.x + insets.left + FIT_MARGIN - CANVAS_PAD * fitted.scale, y: fitted.y + FIT_MARGIN - CANVAS_PAD * fitted.scale };
  };

  // Placed once the box is measured: the whole graph.
  useLayoutEffect(() => {
    if (!view && size.width > 0 && size.height > 0) setView(fitNodes(), true);
  }, [size, view]);

  // The drawing grew or shrank on the left or the top: the view follows, so the nodes stay put.
  const origin = useRef({ x: bounds.x, y: bounds.y });
  useLayoutEffect(() => {
    const was = origin.current;
    origin.current = { x: bounds.x, y: bounds.y };
    const current = panZoom.current();
    if (!current || (was.x === bounds.x && was.y === bounds.y)) return;
    setView({ ...current, x: current.x + (bounds.x - was.x) * current.scale, y: current.y + (bounds.y - was.y) * current.scale });
  }, [bounds.x, bounds.y]);

  if (placeRef) {
    placeRef.current = () => {
      const current = panZoom.current();
      if (!current || size.width === 0) return [snap(bounds.x + CANVAS_PAD), snap(bounds.y + CANVAS_PAD)];
      const middle = insets.left + (size.width - insets.left - insets.right) / 2;
      return [snap((middle - current.x) / current.scale + bounds.x - NODE_WIDTH / 2), snap((size.height / 2 - current.y) / current.scale + bounds.y - 32)];
    };
  }

  /** A card being dragged: where it and the pointer began. */
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; from: [number, number]; moved: boolean } | null>(null);
  /** A wire being drawn from an output, its loose end at the pointer, in the drawing's terms. */
  const [loose, setLoose] = useState<{ from: string; output: string; x: number; y: number; over?: string } | null>(null);

  const onCardDown = (id: string) => (event: ReactPointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!movable) return;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, from: posOf(spec.nodes[id]), moved: false };
  };
  const onCardMove = (event: ReactPointerEvent) => {
    const current = drag.current;
    const scale = panZoom.current()?.scale ?? 1;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    current.moved = true;
    onChange(moveNode(spec, current.id, [snap(current.from[0] + dx / scale), snap(current.from[1] + dy / scale)]));
  };
  const onCardUp = (id: string) => (event: ReactPointerEvent) => {
    const moved = drag.current?.moved ?? false;
    drag.current = null;
    if (!moved && event.type === 'pointerup') onSelect({ kind: 'node', id });
  };

  const onPortDown = (from: string, output: string) => (event: ReactPointerEvent) => {
    if (!editable || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    const at = panZoom.toDrawing(event.clientX, event.clientY);
    if (at) setLoose({ from, output, x: at.x, y: at.y });
  };
  // A port's events stay the port's: the card it is on would take its release for a tap.
  const onPortMove = (event: ReactPointerEvent) => {
    event.stopPropagation();
    if (!loose) return;
    const at = panZoom.toDrawing(event.clientX, event.clientY);
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? undefined;
    if (at) setLoose({ ...loose, x: at.x, y: at.y, over });
  };
  /** While a wire is drawn, the cards it may be dropped on: the same test a drop makes. */
  const targets = useMemo(
    () => loose ? new Set(Object.keys(spec.nodes).filter((to) => mayConnect(spec, { from: loose.from, output: loose.output, to }))) : undefined,
    [spec, loose?.from, loose?.output],
  );
  const onPortUp = (event: ReactPointerEvent) => {
    event.stopPropagation();
    if (!loose) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-node-id]');
    const to = target?.getAttribute('data-node-id');
    if (to && to !== loose.from && takesInput(spec.nodes[to])) {
      const next = connect(spec, { from: loose.from, output: loose.output, to });
      if (next !== spec) onChange(next);
    }
    setLoose(null);
  };

  const problemsOf = (id: string) => problems.filter((problem) => problem.node === id);
  const wires = wiresOf(spec);
  const local = (node: AutomationNodeSpec) => ({ x: posOf(node)[0] - bounds.x, y: posOf(node)[1] - bounds.y });

  return (
    <Box style={{ position: 'relative', height: '100%', minHeight: 0 }}>
      <Box
        ref={panZoom.ref}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          touchAction: 'none',
          userSelect: 'none',
          cursor: panZoom.dragging ? 'grabbing' : 'grab',
          background: 'var(--mrx-surface-base)',
        }}
      >
        <HatGround width={size.width} height={size.height} seed={seed} />
        <Box
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: content.width,
            height: content.height,
            transformOrigin: '0 0',
            transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined,
            visibility: view ? undefined : 'hidden',
          }}
        >
          <svg width={content.width} height={content.height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden='true'>
            {wires.map((wire) => {
              const from = spec.nodes[wire.from];
              const to = spec.nodes[wire.to];
              const a = local(from);
              const b = local(to);
              const d = wirePath(a.x + NODE_WIDTH, a.y + outputY(from, wire.output), b.x, b.y + inputY(to));
              const chosen = selection?.kind === 'wire' && sameWire(selection.wire, wire);
              const colour = wire.output === 'true' ? 'var(--mantine-color-teal-6)' : wire.output === 'false' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-dimmed)';
              return (
                <g key={`${wire.from}:${wire.output}:${wire.to}`}>
                  <path d={d} fill='none' stroke={chosen ? 'var(--mantine-primary-color-filled)' : colour} strokeWidth={chosen ? 3 : 2} />
                  <path
                    d={d}
                    data-pan-ignore=''
                    fill='none'
                    stroke='transparent'
                    strokeWidth={14}
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onClick={() => onSelect({ kind: 'wire', wire })}
                  />
                </g>
              );
            })}
            {loose && spec.nodes[loose.from] && (() => {
              const from = spec.nodes[loose.from];
              const a = local(from);
              return (
                <path
                  d={wirePath(a.x + NODE_WIDTH, a.y + outputY(from, loose.output), loose.x, loose.y)}
                  fill='none'
                  stroke='var(--mantine-primary-color-filled)'
                  strokeWidth={2}
                  strokeDasharray='6 4'
                />
              );
            })()}
          </svg>
          {entries.map(([id, node]) => {
            const kind = KINDS[node.type];
            const color = kind?.color ?? 'gray';
            const at = local(node);
            const height = nodeHeight(node);
            const wrong = problemsOf(id);
            const chosen = selection?.kind === 'node' && selection.id === id;
            const said = statusText(status?.[id], now);
            return (
              <Box
                key={id}
                data-node-id={id}
                data-pan-ignore=''
                onPointerDown={onCardDown(id)}
                onPointerMove={onCardMove}
                onPointerUp={onCardUp(id)}
                onPointerCancel={onCardUp(id)}
                style={{
                  position: 'absolute',
                  left: at.x,
                  top: at.y,
                  width: NODE_WIDTH,
                  height,
                  borderRadius: 'var(--mantine-radius-md)',
                  border: `${chosen ? 2 : 1}px solid ${
                    wrong.length ? 'var(--mantine-color-red-6)' : chosen ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-default-border)'
                  }`,
                  // A band in the kind's colour behind its title.
                  background: `linear-gradient(var(--mantine-color-${color}-light) 0 ${CARD_BAND}px, transparent ${CARD_BAND}px), var(--mrx-surface-raised)`,
                  boxShadow: 'var(--mantine-shadow-xs)',
                  cursor: movable ? 'move' : 'pointer',
                  padding: '0 14px',
                }}
              >
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, height: CARD_BAND }}>
                    <TablerIcon name={kind?.icon ?? 'help'} size={16} color={`var(--mantine-color-${color}-light-color)`} />
                    <Text size='sm' fw={600} truncate>{typeof node.label === 'string' && node.label ? node.label : id}</Text>
                  </Box>
                  <Text size='xs' c='dimmed' truncate mt={8}>{wrong.length ? wrong[0].message : summaryOf(node) || kind?.label}</Text>
                  {(status?.[id]?.problem || said) && <Text size='xs' c={status?.[id]?.problem ? 'red' : 'teal'} truncate>{status?.[id]?.problem ?? said}</Text>}
                </Stack>
                {kind?.input !== false && (() => {
                  // While a wire is drawn: lit where it may go, more so under the pointer, dim elsewhere.
                  const target = targets?.has(id);
                  const over = target && loose?.over === id;
                  const size = over ? 22 : target ? 18 : 14;
                  return (
                    <Box
                      data-wire-target={target || undefined}
                      style={{
                        position: 'absolute',
                        left: -size / 2,
                        top: inputY(node) - size / 2,
                        width: size,
                        height: size,
                        borderRadius: '50%',
                        background: target ? 'var(--mantine-primary-color-filled)' : 'var(--mrx-surface-raised)',
                        border: `2px solid ${target ? 'var(--mantine-primary-color-light-color)' : 'var(--mantine-color-dimmed)'}`,
                        boxShadow: target ? `0 0 0 ${over ? 8 : 4}px var(--mantine-primary-color-light)` : undefined,
                        opacity: targets && !target ? 0.35 : 1,
                        transition: 'width 120ms, height 120ms, left 120ms, top 120ms, box-shadow 120ms',
                      }}
                    />
                  );
                })()}
                {outputsOf(node).map((output) => (
                  <Tooltip key={output} label={output} disabled={outputsOf(node).length < 2} position='right' withArrow>
                    <Box
                      data-pan-ignore=''
                      aria-label={`wire ${output} from ${id}`}
                      onPointerDown={onPortDown(id, output)}
                      onPointerMove={onPortMove}
                      onPointerUp={onPortUp}
                      onPointerCancel={() => setLoose(null)}
                      style={{
                        position: 'absolute',
                        right: -9,
                        top: outputY(node, output) - 9,
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        background: output === 'true' ? 'var(--mantine-color-teal-6)' : output === 'false' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-dimmed)',
                        border: '3px solid var(--mrx-surface-raised)',
                        cursor: editable ? 'crosshair' : 'default',
                      }}
                    />
                  </Tooltip>
                ))}
              </Box>
            );
          })}
          {/* Above the cards: a label on a short wire may reach over their edges. */}
          {status && wires.map((wire) => {
            const sent = status[wire.from]?.outputs?.[wire.output];
            if (!sent) return null;
            const from = spec.nodes[wire.from];
            const to = spec.nodes[wire.to];
            const a = local(from);
            const b = local(to);
            const middle = wireMiddle(a.x + NODE_WIDTH, a.y + outputY(from, wire.output), b.x, b.y + inputY(to));
            const fresh = (now ?? Date.now()) - Date.parse(sent.at) < FRESH_MS;
            return (
              <Box
                key={`label:${wire.from}:${wire.output}:${wire.to}`}
                title={`${wire.from} sent ${wireValue(sent.value)} to ${wire.to} at ${formatTime(sent.at)}`}
                style={{
                  position: 'absolute',
                  left: middle.x,
                  top: middle.y,
                  transform: 'translate(-50%, -50%)',
                  pointerEvents: 'none',
                  zIndex: 1,
                  whiteSpace: 'nowrap',
                  padding: '0 6px',
                  borderRadius: 999,
                  fontSize: 11,
                  lineHeight: '16px',
                  border: `1px solid ${fresh ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-default-border)'}`,
                  background: fresh ? 'var(--mantine-primary-color-light)' : 'var(--mrx-surface-raised)',
                  boxShadow: 'var(--mantine-shadow-xs)',
                  transition: 'background 400ms, border-color 400ms',
                }}
              >
                <Text span size='11px' fw={600} ff='monospace'>{wireValue(sent.value)}</Text>
                <Text span size='11px' c='dimmed'>{` · ${agoText(sent.at, now)}`}</Text>
              </Box>
            );
          })}
        </Box>
      </Box>
      <Stack gap={8} style={{ position: 'absolute', top: 8, right: 8 + insets.right, zIndex: 1 }}>
        {tools}
        <Tooltip label='Fit the whole automation' position='left'>
          <ActionIcon variant='filled' color='dark' size={36} onClick={() => panZoom.animateTo(fitNodes(), true)} aria-label='Fit the whole automation'>
            <TablerIcon name='zoom-scan' size={18} />
          </ActionIcon>
        </Tooltip>
      </Stack>
    </Box>
  );
}

/** Take the selected node or wire out when Delete or Backspace is pressed outside a field. */
export function useDeleteKey(active: boolean, onDelete: () => void) {
  const handler = useRef(onDelete);
  handler.current = onDelete;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], .cm-editor')) return;
      event.preventDefault();
      handler.current();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [active]);
}
