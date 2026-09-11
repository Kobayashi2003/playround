import {
  normalizeProgression,
  type TextDirection,
  type WritingMode,
} from '../../../../epub/publication';
import type { RenditionPlan } from '../../../rendition';
import {
  calculatePaginatedGeometry,
  pageOffsetForProgression,
  scrollProgression,
} from '../geometry';
import type {
  HorizontalFlowDirection,
  ReflowableLayoutSnapshot,
  ReflowablePresentation,
  ReflowableRendererPolicy,
} from '../model';
import { reflowablePageGap, reflowablePageWidth } from '../styles';

export interface PagingAxis {
  readonly extent: number;
  readonly max: number;
  read(): number;
  write(logicalOffset: number): void;
}

export interface DocumentMeasurement {
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

export function inspectComputedPresentation(
  document: Document,
  plan: RenditionPlan,
): ReflowablePresentation {
  const win = document.defaultView;
  const root = document.documentElement;
  const body = document.body;
  const rootStyle = root && win ? win.getComputedStyle(root) : null;
  const bodyStyle = body && win ? win.getComputedStyle(body) : null;

  const writingMode = normalizeWritingMode(
    bodyStyle?.writingMode || rootStyle?.writingMode || plan.writingMode.value,
  );
  const textDirection = normalizeDirection(
    bodyStyle?.direction || rootStyle?.direction || plan.textDirection.value,
  );

  return {
    writingMode,
    textDirection,
    scrollAxis: reflowableScrollAxis(writingMode, plan.renderer),
    horizontalFlow: horizontalFlow(writingMode, textDirection),
  };
}

/** Resolve the physical axis along which reading progression advances. */
export function reflowableScrollAxis(
  writingMode: WritingMode,
  renderer: RenditionPlan['renderer'],
): 'horizontal' | 'vertical' {
  if (renderer === 'reflowable-paginated') {
    return writingMode === 'horizontal-tb' ? 'horizontal' : 'vertical';
  }
  return writingMode === 'horizontal-tb' ? 'vertical' : 'horizontal';
}

export function snapshotReflowableLayout(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
): ReflowableLayoutSnapshot {
  const scrolling = getScrollingElement(document);
  const measurement = measureDocument(document);

  if (plan.renderer === 'reflowable-paginated') {
    const axis = pagingAxis(scrolling, measurement, plan, presentation);
    const pageGap = reflowablePageGap(plan, policy, presentation.writingMode);
    const pageWidth = reflowablePageWidth(
      plan,
      policy,
      presentation.writingMode,
    );
    const geometry = calculatePaginatedGeometry({
      scrollExtent: axis.extent,
      pageExtent: pageWidth,
      pageGap,
      logicalOffset: axis.read(),
    });
    return {
      measurement,
      pageCount: geometry.pageCount,
      currentPage: geometry.currentPage,
      progression: geometry.progression,
      resourceBoundary: {
        atStart: geometry.currentPage === 1,
        atEnd:
          geometry.currentPage + visiblePageCount(plan, presentation) - 1 >=
          geometry.pageCount,
      },
      writingMode: presentation.writingMode,
      textDirection: presentation.textDirection,
      scrollAxis: presentation.scrollAxis,
      pageGap,
      pageWidth,
      visiblePageCount: visiblePageCount(plan, presentation),
    };
  }

  const horizontal = presentation.scrollAxis === 'horizontal';
  const max = horizontal
    ? Math.max(0, measurement.scrollWidth - plan.viewport.width)
    : Math.max(0, measurement.scrollHeight - plan.viewport.height);
  const logicalOffset = horizontal
    ? getHorizontalLogicalOffset(scrolling, presentation.horizontalFlow, max)
    : Math.max(0, scrolling.scrollTop);

  return {
    measurement,
    progression: scrollProgression(logicalOffset, max),
    resourceBoundary: {
      atStart: logicalOffset <= 1,
      atEnd: logicalOffset >= max - 1,
    },
    writingMode: presentation.writingMode,
    textDirection: presentation.textDirection,
    scrollAxis: presentation.scrollAxis,
  };
}

export function restoreProgression(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
  progression: number,
): void {
  const scrolling = getScrollingElement(document);
  const measurement = measureDocument(document);
  const normalized = normalizeProgression(progression);

  if (plan.renderer === 'reflowable-paginated') {
    const axis = pagingAxis(scrolling, measurement, plan, presentation);
    const geometry = calculatePaginatedGeometry({
      scrollExtent: axis.extent,
      pageExtent: reflowablePageWidth(plan, policy, presentation.writingMode),
      pageGap: reflowablePageGap(plan, policy, presentation.writingMode),
      logicalOffset: 0,
    });
    axis.write(
      pageOffsetForProgression(
        normalized,
        geometry.pageCount,
        geometry.pageAdvance,
      ),
    );
    return;
  }

  if (presentation.scrollAxis === 'vertical') {
    const max = Math.max(0, measurement.scrollHeight - plan.viewport.height);
    scrolling.scrollTop = normalized * max;
    return;
  }

  const max = Math.max(0, measurement.scrollWidth - plan.viewport.width);
  setHorizontalLogicalOffset(
    scrolling,
    presentation.horizontalFlow,
    max,
    normalized * max,
  );
}

export function visiblePageCount(
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
): 1 | 2 {
  if (presentation.writingMode !== 'horizontal-tb') return 1;
  return plan.spread.execution === 'intra-document' ? 2 : 1;
}

export function pagingAxis(
  scrolling: HTMLElement,
  measurement: DocumentMeasurement,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
): PagingAxis {
  if (presentation.scrollAxis === 'vertical') {
    const extent = measurement.scrollHeight;
    const max = Math.max(0, extent - plan.viewport.height);
    return {
      extent,
      max,
      read: () => clamp(Math.max(0, scrolling.scrollTop), 0, max),
      write: (value) => {
        scrolling.scrollTop = clamp(value, 0, max);
      },
    };
  }

  const extent = measurement.scrollWidth;
  const max = Math.max(0, extent - plan.viewport.width);
  return {
    extent,
    max,
    read: () =>
      getHorizontalLogicalOffset(scrolling, presentation.horizontalFlow, max),
    write: (value) =>
      setHorizontalLogicalOffset(
        scrolling,
        presentation.horizontalFlow,
        max,
        value,
      ),
  };
}

export function snapPaginatedToPage(
  document: Document,
  plan: RenditionPlan,
  presentation: ReflowablePresentation,
  policy: ReflowableRendererPolicy,
): void {
  const axis = pagingAxis(
    getScrollingElement(document),
    measureDocument(document),
    plan,
    presentation,
  );
  const geometry = calculatePaginatedGeometry({
    scrollExtent: axis.extent,
    pageExtent: reflowablePageWidth(plan, policy, presentation.writingMode),
    pageGap: reflowablePageGap(plan, policy, presentation.writingMode),
    logicalOffset: axis.read(),
  });
  axis.write(geometry.snappedOffset);
}

export function measureDocument(document: Document): DocumentMeasurement {
  const root = document.documentElement;
  const body = document.body;
  return {
    clientWidth: root?.clientWidth ?? body?.clientWidth ?? 0,
    clientHeight: root?.clientHeight ?? body?.clientHeight ?? 0,
    scrollWidth: Math.max(root?.scrollWidth ?? 0, body?.scrollWidth ?? 0),
    scrollHeight: Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0),
  };
}

export function getScrollingElement(document: Document): HTMLElement {
  const element =
    document.scrollingElement ?? document.documentElement ?? document.body;
  if (!element || element.nodeType !== 1 || !('scrollLeft' in element)) {
    throw new Error(
      'Reflowable document does not expose an HTML scrolling element.',
    );
  }
  // The scrolling element belongs to the iframe realm; structural checks work
  // where instanceof HTMLElement against the parent realm would fail.
  return element as HTMLElement;
}

/** Normalize browser RTL scrollLeft models into distance from authored start. */
export function getHorizontalLogicalOffset(
  element: HTMLElement,
  flow: HorizontalFlowDirection,
  max: number,
): number {
  if (flow === 'left-to-right') {
    return clamp(Math.max(0, element.scrollLeft), 0, max);
  }

  const raw = element.scrollLeft;
  if (raw < 0) return clamp(-raw, 0, max);
  return detectPositiveRtlModel(element, raw) === 'start-at-max'
    ? clamp(max - raw, 0, max)
    : clamp(raw, 0, max);
}

export function setHorizontalLogicalOffset(
  element: HTMLElement,
  flow: HorizontalFlowDirection,
  max: number,
  logicalOffset: number,
): void {
  const value = clamp(logicalOffset, 0, max);
  if (flow === 'left-to-right') {
    element.scrollLeft = value;
    return;
  }

  const original = element.scrollLeft;
  element.scrollLeft = -value;
  if (value === 0 || element.scrollLeft < 0) return;

  element.scrollLeft = original;
  const model = detectPositiveRtlModel(element, original);
  element.scrollLeft = model === 'start-at-max' ? max - value : value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function detectPositiveRtlModel(
  element: HTMLElement,
  current: number,
): 'start-at-zero' | 'start-at-max' {
  if (current > 0) return 'start-at-max';
  const original = element.scrollLeft;
  element.scrollLeft = 1;
  const acceptsPositive = element.scrollLeft > 0;
  element.scrollLeft = original;
  return acceptsPositive ? 'start-at-zero' : 'start-at-max';
}

function normalizeWritingMode(value: string): WritingMode {
  const normalized = value.trim().toLowerCase();
  return normalized === 'vertical-rl' || normalized === 'vertical-lr'
    ? normalized
    : 'horizontal-tb';
}

function normalizeDirection(value: string): TextDirection {
  const normalized = value.trim().toLowerCase();
  return normalized === 'rtl' || normalized === 'ltr' ? normalized : 'auto';
}

function horizontalFlow(
  writingMode: WritingMode,
  direction: TextDirection,
): HorizontalFlowDirection {
  if (writingMode === 'vertical-rl') return 'right-to-left';
  if (writingMode === 'vertical-lr') return 'left-to-right';
  return direction === 'rtl' ? 'right-to-left' : 'left-to-right';
}
