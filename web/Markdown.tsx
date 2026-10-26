import { createContext, memo, useContext, useEffect, useRef, useState, type ComponentProps } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

const COPY_OUTCOME_SHOWN_MS = 1_500;
const OPEN_FILE_HINT = "Opens the file in the program the host's system uses for it, on the machine Mirador runs on.";
const BLOCKED_IMAGE_HINT =
  "Opens the image in your browser. Mirador does not load images from other sites itself, so an agent cannot send them what it read; Settings → Conversations can change that.";

/** The block's text as written: markdown ends a code block's last line with a line break the author did not write. */
const codeIn = (block: HTMLPreElement | null) => (block?.textContent ?? "").replace(/\n$/, "");

/** A path as Mirador's chat links one: absolute, or through a folder, to a file with an extension. */
const looksLikeFilePath = (text: string) => /^(?:[a-zA-Z]:[\\/]|[\/\\]|[\w.-]+[\\/])\S*\.\w+$/.test(text);

/** Opens a file as a file link in Mirador's chat does; a Mirador from before plugin views could open files has none. */
const openFile = (globalThis as { mirador?: { openFile?: (path: string) => void } }).mirador?.openFile;

const InsideCodeBlock = createContext(false);

function CodeBlock({ node: _node, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const block = useRef<HTMLPreElement>(null);
  const [label, setLabel] = useState<"Copy" | "Copied" | "Copy failed">("Copy");
  useEffect(() => {
    if (label === "Copy") return;
    const backToCopy = setTimeout(() => setLabel("Copy"), COPY_OUTCOME_SHOWN_MS);
    return () => clearTimeout(backToCopy);
  }, [label]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codeIn(block.current));
      setLabel("Copied");
    } catch {
      setLabel("Copy failed");
    }
  };
  return (
    <div className="copyable-code">
      <InsideCodeBlock.Provider value={true}>
        <pre ref={block} {...props} />
      </InsideCodeBlock.Provider>
      <button type="button" className={`code-copy ${label === "Copy" ? "" : "shown"}`} onClick={copy}>
        {label}
      </button>
    </div>
  );
}

/** Whether images from other sites show as links, as Mirador's Settings say for the canvas. */
export const ExternalImagesBlocked = createContext(true);

/** A badge is an image inside a link, and a link cannot hold another. */
const InsideLink = createContext(false);

function MarkdownLink({ node: _node, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  return (
    <a {...props} target="_blank" rel="noreferrer">
      <InsideLink.Provider value={true}>{children}</InsideLink.Provider>
    </a>
  );
}

function isFromAnotherSite(source: string) {
  try {
    const url = new URL(source, location.href);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== location.origin;
  } catch {
    return false;
  }
}

function MarkdownImage({ node: _node, ...props }: ComponentProps<"img"> & ExtraProps) {
  const blocked = useContext(ExternalImagesBlocked);
  const insideLink = useContext(InsideLink);
  const source = typeof props.src === "string" ? props.src : "";
  if (!blocked || !isFromAnotherSite(source)) return <img {...props} />;
  const site = new URL(source, location.href).hostname;
  const label = props.alt ? `${props.alt} (image from ${site})` : `Image from ${site}`;
  if (insideLink) return <span className="blocked-image">{label}</span>;
  return (
    <a href={source} target="_blank" rel="noreferrer" className="blocked-image" data-hint={BLOCKED_IMAGE_HINT}>
      {label}
    </a>
  );
}

function MarkdownCode({ node: _node, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  const insideCodeBlock = useContext(InsideCodeBlock);
  const text = typeof children === "string" ? children : "";
  if (!openFile || insideCodeBlock || !looksLikeFilePath(text)) return <code {...props}>{children}</code>;
  return (
    <button type="button" className="file-link" data-hint={OPEN_FILE_HINT} onClick={() => openFile(text)}>
      <code>{text}</code>
    </button>
  );
}

const markdownComponents: Components = { a: MarkdownLink, img: MarkdownImage, pre: CodeBlock, code: MarkdownCode };

/** Parsing is the costly part, so a re-render with the same text reuses the last result. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </Markdown>
    </div>
  );
});
