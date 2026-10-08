import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeHtml } from "./sanitize.ts";

test("keeps allowlisted tags and strips their attributes", () => {
  assert.equal(
    sanitizeHtml('<p dir="auto">Hi <code class="notranslate">x</code> <strong>y</strong></p>'),
    "<p>Hi <code>x</code> <strong>y</strong></p>",
  );
});

test("drops script and style with their contents", () => {
  assert.equal(sanitizeHtml("<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>"), "<p>a</p><p>b</p>");
});

test("unwraps unknown tags but keeps their text", () => {
  assert.equal(
    sanitizeHtml('<div class="highlight"><pre>code</pre></div><span>t</span>'),
    "<pre>code</pre>t",
  );
});

test("keeps https links with safe attributes only", () => {
  assert.equal(
    sanitizeHtml('<a href="https://github.com/x" class="user-mention" onclick="evil()">@x</a>'),
    '<a href="https://github.com/x" target="_blank" rel="noopener">@x</a>',
  );
});

test("unwraps links that are not https", () => {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">click</a>'), "click");
  assert.equal(sanitizeHtml('<a href="http://example.com">plain</a>'), "plain");
  assert.equal(sanitizeHtml("<a>no href</a>"), "no href");
});

test("drops event handler attributes on kept tags", () => {
  assert.equal(sanitizeHtml('<p onclick="x()" onmouseover=y>a</p>'), "<p>a</p>");
});

test("downgrades h1 and h2 to h3, h5 and h6 to h4", () => {
  assert.equal(sanitizeHtml("<h2>T</h2><h1>U</h1><h6>V</h6>"), "<h3>T</h3><h3>U</h3><h4>V</h4>");
});

test("drops img and other void tags that are not allowed", () => {
  assert.equal(sanitizeHtml('<p><img src="x" onerror="alert(1)">after</p>'), "<p>after</p>");
  assert.equal(sanitizeHtml('<input type="checkbox" checked> item'), "item");
});

test("closes unclosed tags and ignores stray closers", () => {
  assert.equal(sanitizeHtml("<ul><li>a</li>"), "<ul><li>a</li></ul>");
  assert.equal(sanitizeHtml("<p>x"), "<p>x</p>");
  assert.equal(sanitizeHtml("</p>x</div>"), "x");
});

test("escapes a stray less-than in text", () => {
  assert.equal(sanitizeHtml("<p>a < b</p>"), "<p>a &lt; b</p>");
});

test("keeps tables and removes comments", () => {
  assert.equal(
    sanitizeHtml("<!-- c --><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>"),
    "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>",
  );
});

test("keeps br and hr as void tags", () => {
  assert.equal(sanitizeHtml("a<br>b<hr>c"), "a<br>b<hr>c");
});
