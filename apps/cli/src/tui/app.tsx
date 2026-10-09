import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ColorLevel } from '../output/color.ts';
import type { TuiController } from './controller.ts';
import type { TuiTranslate } from './i18n.ts';
import { renderFrame } from './render.ts';

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** The terminal's size, updated on resize (80×24 when the stream does not say). */
export function useTerminalSize(): TerminalSize {
  const stdout = useStdout().stdout as NodeJS.WritableStream & { columns?: number; rows?: number };
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  }));
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

export interface TuiAppProps {
  controller: TuiController;
  level: ColorLevel;
  t: TuiTranslate;
  collab: TuiTranslate;
  /** Gets Ink's terminal hand-over, for `$EDITOR`. */
  onSuspend?: (suspend: (run: () => Promise<void>) => Promise<void>) => void;
}

/**
 * The Ink root: renders the controller's state as one frame of exact-width lines and forwards
 * every key to it. All behaviour lives in `TuiController` and `renderFrame`.
 */
export function TuiApp({ controller, level, t, collab, onSuspend }: TuiAppProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const { columns, rows } = useTerminalSize();
  const app = useApp();
  const top = useRef(0);
  useEffect(() => {
    controller.attach({ exit: () => app.exit() });
    onSuspend?.((run) => app.suspendTerminal(run));
  }, [controller, app, onSuspend]);
  useInput((input, key) => controller.key(input, key));
  const frame = renderFrame({
    controller,
    state,
    width: columns,
    height: rows,
    level,
    t,
    collab,
    top: top.current,
  });
  top.current = frame.top;
  useEffect(() => controller.setPageSize(frame.bodyRows), [controller, frame.bodyRows]);
  return (
    <Box flexDirection="column">
      {frame.lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
