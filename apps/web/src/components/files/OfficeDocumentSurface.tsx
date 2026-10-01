import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { base64ToBytes } from "@t3tools/shared/spreadsheetWorkbook";
import { useProjectBinaryFileQuery } from "./projectFilesQueryState";

function xmlSize(entry: object): number {
  const data = "_data" in entry ? entry._data : null;
  return typeof data === "object" &&
    data !== null &&
    "uncompressedSize" in data &&
    typeof data.uncompressedSize === "number"
    ? data.uncompressedSize
    : Infinity;
}

/** A safe text preview; layout and embedded objects stay in the original office file. */
export function OfficeDocumentSurface(props: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}) {
  const file = useProjectBinaryFileQuery(props.environmentId, props.cwd, props.relativePath, true);
  const [preview, setPreview] = useState<{
    source: typeof file.data;
    path: string;
    sections: readonly { id: string; title: string; text: { id: string; value: string }[] }[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const data = file.data;
    if (!data || data.truncated) return;
    void (async () => {
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(base64ToBytes(data.contents));
      const names = props.relativePath.toLowerCase().endsWith(".docx")
        ? ["word/document.xml"]
        : Object.keys(zip.files)
            .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
            .toSorted(
              (a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]),
            );
      const result = [];
      let length = 0;
      for (const [index, name] of names.entries()) {
        const entry = zip.file(name);
        if (!entry || xmlSize(entry) > 2_000_000)
          throw new Error(
            "This file is too complex for a text preview. Open it in your document app.",
          );
        const xml = await entry.async("string");
        length += xml.length;
        if (length > 4_000_000)
          throw new Error(
            "This file is too large for a text preview. Open it in your document app.",
          );
        const document = new DOMParser().parseFromString(xml, "application/xml");
        if (document.getElementsByTagName("parsererror").length)
          throw new Error("This document could not be read. The original file is kept.");
        const paragraphs = [...document.getElementsByTagNameNS("*", "p")]
          .map((paragraph) =>
            [...paragraph.getElementsByTagName("*")]
              .map((element) =>
                element.localName === "t"
                  ? (element.textContent ?? "")
                  : element.localName === "br"
                    ? "\n"
                    : element.localName === "tab"
                      ? "\t"
                      : "",
              )
              .join(""),
          )
          .filter(Boolean);
        result.push({
          id: name,
          title: `Slide ${index + 1}`,
          text: paragraphs.map((value, position) => ({ id: `${name}#${position}`, value })),
        });
      }
      if (!names.length)
        throw new Error("No readable slides were found. The original file is kept.");
      if (!cancelled)
        setPreview({ source: data, path: props.relativePath, sections: result, error: null });
    })().catch((cause: unknown) => {
      if (!cancelled)
        setPreview({
          source: data,
          path: props.relativePath,
          sections: [],
          error: cause instanceof Error ? cause.message : "Could not preview this document.",
        });
    });
    return () => {
      cancelled = true;
    };
  }, [file.data, props.relativePath]);
  const current =
    preview?.source === file.data && preview.path === props.relativePath ? preview : null;
  const sections = current?.sections;
  const error = file.data?.truncated
    ? "This file is too large for a text preview. Save a copy and open it in your document app."
    : current?.error;
  if (file.error || error)
    return (
      <p role="alert" className="p-4 text-sm text-muted-foreground">
        {file.error ?? error}
      </p>
    );
  if (!sections)
    return (
      <p role="status" className="p-4 text-sm">
        Loading document…
      </p>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <p className="mb-4 text-xs text-muted-foreground">
        Text preview. Formatting, images and charts are preserved in the original file; save a copy
        to view them in your document app.
      </p>
      {sections.map((section) => (
        <section key={section.id} className="mb-5">
          {props.relativePath.toLowerCase().endsWith(".pptx") ? (
            <h2 className="mb-3 text-lg font-medium">{section.title}</h2>
          ) : null}
          {section.text.map((text) => (
            <p key={text.id} className="mb-2 whitespace-pre-wrap break-words text-sm">
              {text.value}
            </p>
          ))}
          {!section.text.length ? <p>No readable text in this section.</p> : null}
        </section>
      ))}
    </div>
  );
}
