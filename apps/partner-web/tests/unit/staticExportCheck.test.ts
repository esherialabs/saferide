import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cssProblems, htmlProblems, svgProblems } from '../../scripts/check-static-export.mjs';

const clean = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/_next/static/css/a.css"/></head>'
  + '<body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"page":"/"}</script>'
  + '<script src="/_next/static/chunks/main.js" defer=""></script></body></html>';

describe('static export check', () => {
  it('accepts the shape Next exports', () => {
    assert.deepEqual(htmlProblems(clean), []);
    assert.deepEqual(htmlProblems('<img srcset="/a.png 1x, /b.png 2x" alt="">'), []);
  });

  it('refuses inline code, styles and handlers', () => {
    assert.deepEqual(htmlProblems('<script>alert(1)</script>'), ['page: inline script']);
    assert.deepEqual(htmlProblems('<style>p{}</style>'), ['page: <style> element']);
    assert.deepEqual(htmlProblems('<p style="color:red">x</p>'), ['page: style attribute']);
    assert.deepEqual(htmlProblems('<img src="/a.png" onerror="x()">'), ['page: event-handler attribute']);
  });

  it('refuses third-party URLs, including in srcset and formaction', () => {
    assert.deepEqual(htmlProblems('<script src="https://cdn.example.test/x.js"></script>'), ['page: third-party URL']);
    assert.deepEqual(htmlProblems('<img srcset="/a.png 1x, https://cdn.example.test/b.png 2x" alt="">'), ['page: third-party URL in srcset']);
    assert.deepEqual(htmlProblems('<img srcset="//cdn.example.test/b.png 2x" alt="">'), ['page: third-party URL in srcset']);
    assert.deepEqual(htmlProblems('<button formaction="https://evil.example.test/">x</button>'), ['page: third-party URL']);
  });

  it('refuses meta refresh and <base>', () => {
    assert.deepEqual(htmlProblems('<meta http-equiv="refresh" content="0;url=/x">'), ['page: meta refresh']);
    assert.deepEqual(htmlProblems("<meta content='5' http-equiv='Refresh'>"), ['page: meta refresh']);
    assert.deepEqual(htmlProblems('<base href="/x/">'), ['page: <base> element']);
  });

  it('refuses external CSS resources', () => {
    assert.deepEqual(cssProblems('body{background:url(/a.png)}'), []);
    assert.deepEqual(cssProblems('@import url("/x.css");'), ['stylesheet: external CSS resource']);
    assert.deepEqual(cssProblems('body{background:url(https://cdn.example.test/a.png)}'), ['stylesheet: external CSS resource']);
  });

  it('keeps served SVGs inert and same-origin', () => {
    const clean = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><use href="#a"/><rect fill="#000"/></svg>';
    assert.deepEqual(svgProblems(clean), []);
    assert.deepEqual(svgProblems('<svg><script>alert(1)</script></svg>'), ['image.svg: script in SVG']);
    assert.deepEqual(svgProblems('<svg><rect onclick="x()"/></svg>'), ['image.svg: event-handler attribute in SVG']);
    assert.deepEqual(svgProblems('<svg><image href="https://cdn.example.test/a.png"/></svg>'), ['image.svg: external reference in SVG']);
    assert.deepEqual(svgProblems('<svg><use xlink:href="//cdn.example.test/s.svg#a"/></svg>'), ['image.svg: external reference in SVG']);
    assert.deepEqual(svgProblems('<svg><style>@import url(https://x.test/a.css);</style></svg>'), ['image.svg: external reference in SVG']);
    assert.deepEqual(svgProblems('<svg><foreignObject/></svg>'), ['image.svg: foreignObject in SVG']);
  });
});
