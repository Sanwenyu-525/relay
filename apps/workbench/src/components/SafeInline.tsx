export interface InlineSegment {
  readonly kind: "text" | "strong" | "em" | "code" | "link";
  readonly text: string;
  readonly href?: string;
}

export default function SafeInline({ segments }: { segments: readonly InlineSegment[] }) {
  return <>{segments.map((segment, index) => {
    if (segment.kind === "strong") return <strong key={index}>{segment.text}</strong>;
    if (segment.kind === "em") return <em key={index}>{segment.text}</em>;
    if (segment.kind === "code") return <code key={index}>{segment.text}</code>;
    if (segment.kind === "link") return <a key={index} href={segment.href} rel="noreferrer noopener" target="_blank">{segment.text}</a>;
    return <span key={index}>{segment.text}</span>;
  })}</>;
}
