import { CompatChange } from "./types";

/** Namespaces whose elements the HTML parser knows how to adopt on sight. */
const FOREIGN_NS = [
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1998/Math/MathML",
];

/** HTML elements for which an XHTML self-closing slash is unsafe in HTML. */
const NON_VOID_HTML_ELEMENTS = new Set([
  "a", "abbr", "address", "article", "aside", "audio", "b", "bdi", "bdo",
  "blockquote", "button", "caption", "cite", "code", "colgroup", "data",
  "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt",
  "em", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hgroup", "i", "ins", "kbd", "label",
  "legend", "li", "main", "map", "mark", "menu", "meter", "nav", "noscript",
  "object", "ol", "optgroup", "option", "output", "p", "picture", "pre",
  "progress", "q", "rp", "rt", "ruby", "s", "samp", "section", "select",
  "slot", "small", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time",
  "tr", "u", "ul", "var", "video",
]);

/**
 * Drop a namespace prefix from SVG and MathML element names when the document
 * binds that prefix to the standard foreign-content namespace.
 */
export function unprefixForeignMarkup(html: string): string {
  const declarations = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']+)["']/g;
  const prefixes = new Set<string>();
  for (const match of html.matchAll(declarations)) {
    if (FOREIGN_NS.includes(match[2].trim())) prefixes.add(match[1]);
  }
  if (prefixes.size === 0) return html;

  let output = html;
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    output = output.replace(new RegExp(`(</?)${escaped}:(?=[A-Za-z])`, "g"), "$1");
  }
  return output;
}
/**
 * Turn XHTML self-closing HTML elements into explicit pairs before the markup
 * enters the forgiving HTML parser. SVG, MathML, and HTML void elements keep
 * their native form.
 */
export function closeSelfClosingHtmlElements(html: string): string {
  return html.replace(
    /<([A-Za-z][\w.-]*)(\b(?:[^>"']|"[^"]*"|'[^']*')*)\/\s*>/g,
    (tag, rawName: string) => {
      const name = rawName.toLowerCase();
      if (!NON_VOID_HTML_ELEMENTS.has(name)) return tag;
      return `${tag.replace(/\/\s*>$/, ">")}</${rawName}>`;
    },
  );
}

/** Prepare XHTML syntax for an HTML `srcdoc` parser and report each repair. */
export function bridgeXhtmlToHtml(html: string): { markup: string; changes: CompatChange[] } {
  const changes: CompatChange[] = [];
  const withoutPrefixes = unprefixForeignMarkup(html);
  if (withoutPrefixes !== html) {
    changes.push({ id: "foreign-namespace-prefixes", phase: "structure", count: 1 });
  }

  const closed = closeSelfClosingHtmlElements(withoutPrefixes);
  if (closed !== withoutPrefixes) {
    changes.push({ id: "self-closing-html-elements", phase: "structure", count: 1 });
  }
  return { markup: closed, changes };
}
