import type { ReaderShortcutGroup } from '../../../../core';
import { CloseIcon } from '../../../chrome/reader-icons';
import type { ReaderSurfaceController } from '../use-reader-surface-controller';
import { useReaderUiConfiguration } from '../../../configuration/context';
import { useEpubReaderContext } from '../../context';
import type {
  ReaderToolContext,
  ReaderToolId,
  ReaderToolModule,
} from '../../../tools/model';
import type { EpubSource } from '../../../state/model';
import {
  ReaderToolBoundary,
  ReaderToolContent,
  ReaderToolModuleIcon,
} from '../../../tools/ReaderToolBoundary';

interface ReaderPanelHostProps {
  readonly source: EpubSource;
  readonly panel: ReaderToolId | null;
  readonly panelId: string;
  readonly panelTitleId: string;
  readonly compactLayout: boolean;
  readonly closing: boolean;
  readonly panelRef: ReaderSurfaceController['panelRef'];
  readonly shellRef: { readonly current: HTMLDivElement | null };
  readonly shortcutGroups?: readonly ReaderShortcutGroup[];
  readonly tools: readonly ReaderToolModule[];
  readonly onShowSurface: ReaderSurfaceController['show'];
  readonly onClose: ReaderSurfaceController['close'];
}

/** Renders registered tool content while the Shell owns the panel lifecycle. */
export function ReaderPanelHost({
  source,
  panel,
  panelId,
  panelTitleId,
  compactLayout,
  closing,
  panelRef,
  shellRef,
  shortcutGroups,
  tools,
  onShowSurface,
  onClose,
}: ReaderPanelHostProps) {
  const reader = useEpubReaderContext();
  const { messages } = useReaderUiConfiguration();
  if (!panel) return null;
  const activeTool = tools.find((tool) => tool.id === panel);
  if (!activeTool) return null;
  const openMarkEditor: ReaderToolContext['openMarkEditor'] = (
    mark,
    trigger,
  ) => {
    const shellBounds = shellRef.current?.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    onShowSurface({
      kind: 'mark',
      source,
      activation: {
        mark,
        anchor: {
          x:
            triggerBounds.left +
            triggerBounds.width / 2 -
            (shellBounds?.left ?? 0),
          y: triggerBounds.bottom - (shellBounds?.top ?? 0),
        },
        returnFocus: trigger,
      },
    });
  };
  return (
    <aside
      id={panelId}
      key="reader-panel"
      ref={panelRef}
      className={`epub-reader-shell__panel${closing ? ' is-closing' : ''}`}
      role={compactLayout ? 'dialog' : undefined}
      aria-modal={compactLayout ? 'true' : undefined}
      aria-labelledby={panelTitleId}
      tabIndex={-1}
    >
      <header className="epub-reader-shell__panel-head">
        <div className="epub-reader-shell__panel-context">
          <span className="epub-reader-shell__panel-icon">
            <ReaderToolModuleIcon tool={activeTool} />
          </span>
          <div>
            <strong id={panelTitleId}>{activeTool.label}</strong>
            <span>{activeTool.description}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onClose()}
          aria-label={messages.closePanel(activeTool.label)}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="epub-reader-shell__panel-content">
        <ReaderToolBoundary
          resetKey={activeTool}
          fallback={<p role="alert">{messages.actionFailed}</p>}
        >
          <ReaderToolContent
            tool={activeTool}
            context={{ reader, shortcutGroups, openMarkEditor }}
          />
        </ReaderToolBoundary>
      </div>
    </aside>
  );
}
