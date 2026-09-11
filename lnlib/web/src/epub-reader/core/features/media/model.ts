export interface ReaderImageActivation {
  readonly src: string;
  readonly alt: string;
  readonly caption?: string;
  readonly intrinsicWidth?: number;
  readonly intrinsicHeight?: number;
  readonly trigger: HTMLImageElement;
}
