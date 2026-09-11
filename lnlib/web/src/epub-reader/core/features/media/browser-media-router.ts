import type { RendererContentDocument } from '../../presentation/renderer';
import type { ReaderImageActivation } from './model';

const VIEWER_ATTRIBUTE = 'data-epub-image-viewer';

/** Adds host-owned image inspection without rewriting publication structure. */
export class BrowserPublicationMediaRouter {
  private readonly cleanups = new Map<Document, () => void>();

  constructor(
    private readonly onImage: (activation: ReaderImageActivation) => void,
  ) {}

  syncDocuments(contexts: readonly RendererContentDocument[]): void {
    const live = new Set(contexts.map((context) => context.document));
    for (const [document, cleanup] of this.cleanups) {
      if (!live.has(document)) {
        cleanup();
        this.cleanups.delete(document);
      }
    }
    for (const context of contexts) {
      if (this.cleanups.has(context.document)) continue;
      this.cleanups.set(context.document, this.attach(context.document));
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
  }

  private attach(document: Document): () => void {
    const enhanced = Array.from(document.images).filter((image) => {
      const role = image.getAttribute('role')?.toLowerCase();
      return (
        !image.closest('a') &&
        image.getAttribute('aria-hidden') !== 'true' &&
        role !== 'presentation' &&
        role !== 'none'
      );
    });
    const records = enhanced.map((image) => ({
      image,
      tabIndex: image.getAttribute('tabindex'),
      role: image.getAttribute('role'),
      ariaLabel: image.getAttribute('aria-label'),
    }));
    for (const image of enhanced) {
      image.setAttribute(VIEWER_ATTRIBUTE, 'true');
      if (!image.hasAttribute('tabindex')) image.tabIndex = 0;
      if (!image.hasAttribute('role')) image.setAttribute('role', 'button');
      if (!image.hasAttribute('aria-label'))
        image.setAttribute(
          'aria-label',
          image.alt.trim()
            ? `View image: ${image.alt.trim()}`
            : 'View publication image',
        );
    }

    const activate = (target: EventTarget | null): boolean => {
      const image = closestImage(target);
      if (!image || !image.hasAttribute(VIEWER_ATTRIBUTE) || image.closest('a'))
        return false;
      const src = image.currentSrc || image.src;
      if (!src) return false;
      const caption = image
        .closest('figure')
        ?.querySelector('figcaption')
        ?.textContent?.replace(/\s+/gu, ' ')
        .trim();
      this.onImage({
        src,
        alt: image.alt.trim(),
        ...(caption ? { caption } : {}),
        ...(image.naturalWidth > 0
          ? { intrinsicWidth: image.naturalWidth }
          : {}),
        ...(image.naturalHeight > 0
          ? { intrinsicHeight: image.naturalHeight }
          : {}),
        trigger: image,
      });
      return true;
    };
    const onClick = (event: Event) => {
      const click = event as MouseEvent;
      if (
        click.button !== 0 ||
        click.altKey ||
        click.ctrlKey ||
        click.metaKey ||
        click.shiftKey ||
        !activate(click.target)
      )
        return;
      click.preventDefault();
      click.stopImmediatePropagation();
    };
    const onKeyDown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Enter' || !activate(key.target)) return;
      key.preventDefault();
      key.stopImmediatePropagation();
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      for (const record of records) {
        const { image } = record;
        image.removeAttribute(VIEWER_ATTRIBUTE);
        restoreAttribute(image, 'tabindex', record.tabIndex);
        restoreAttribute(image, 'role', record.role);
        restoreAttribute(image, 'aria-label', record.ariaLabel);
      }
    };
  }
}

function closestImage(target: EventTarget | null): HTMLImageElement | null {
  if (!target || typeof target !== 'object') return null;
  const node = target as Node;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const image = element?.closest('img');
  return image?.localName.toLowerCase() === 'img'
    ? (image as HTMLImageElement)
    : null;
}

function restoreAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (value == null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
