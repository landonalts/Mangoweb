// api/proxy.js
import fetch from "node-fetch";      // Vercel Node environment supports fetch; node-fetch used if needed
import cheerio from "cheerio";

const ALLOWED_ORIGINS = ["https://yourdomain.com"]; // optional: restrict who can call the proxy

function b64Decode(str) {
  try { return Buffer.from(str, "base64").toString("utf8"); }
  catch(e){ return null; }
}

export default async function handler(req, res) {
  // Allow simple CORS for demo (be careful in production)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const targetB64 = req.query.u || req.query.url; // expect base64 URL in ?u=
  if (!targetB64) return res.status(400).send("Missing target (use ?u=<base64url>)");

  const target = b64Decode(targetB64);
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("Invalid target URL");
  }

  try {
    // Proxy the request, forward some headers but not all (for privacy)
    const upstreamRes = await fetch(target, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MyProxy/1.0)",
        // forward Accept header from client if desired:
        "Accept": req.headers["accept"] || "*/*"
      },
      // credentials, redirect handling etc can be adjusted
    });

    // Copy basic headers (content-type, cache-control) to client
    const contentType = upstreamRes.headers.get("content-type") || "";

    // If HTML, rewrite links and inject toolbar
    if (contentType.includes("text/html")) {
      const text = await upstreamRes.text();
      const $ = cheerio.load(text, { decodeEntities: false });

      // rewrite href/src attributes to route through this proxy
      function rewriteAttributes(sel, attr) {
        $(sel).each((i, el) => {
          const raw = $(el).attr(attr);
          if (!raw) return;
          // ignore anchors and data URIs and javascript: links
          if (raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("javascript:")) return;
          // build absolute URL relative to target
          const abs = new URL(raw, target).toString();
          const proxied = `/api/proxy?u=${Buffer.from(abs).toString("base64")}`;
          $(el).attr(attr, proxied);
        });
      }

      rewriteAttributes('a', 'href');
      rewriteAttributes('img', 'src');
      rewriteAttributes('script', 'src');
      rewriteAttributes('link[rel="stylesheet"]', 'href');
      rewriteAttributes('iframe', 'src');

      // Inject a simple toolbar at top of body
      const toolbarHtml = `
        <div id="my-proxy-toolbar" style="position:fixed;left:0;right:0;top:0;z-index:99999;
             background:rgba(10,10,10,0.85);color:#fff;padding:8px 12px;font-family:sans-serif;
             display:flex;gap:8px;align-items:center">
          <form id="proxy-nav" style="display:flex;flex:1">
            <input id="proxy-url" style="flex:1;padding:6px;border-radius:4px;border:0" value="${target}">
            <button type="submit" style="margin-left:6px;padding:6px 10px;border-radius:4px">Go</button>
          </form>
          <button id="proxy-theme" title="Toggle theme" style="padding:6px 10px;border-radius:4px">Theme</button>
          <button id="proxy-close" style="padding:6px 10px;border-radius:4px">Close</button>
        </div>
        <div style="height:56px"></div> <!-- spacer so page content isn't hidden -->
        <script>
          document.getElementById('proxy-nav').addEventListener('submit', e => {
            e.preventDefault();
            const v = document.getElementById('proxy-url').value;
            try {
              const url = new URL(v).toString();
              const enc = btoa(url);
              window.location.href = '/api/proxy?u=' + enc;
            } catch(err) {
              alert('Enter a full URL including https://');
            }
          });
          document.getElementById('proxy-close').addEventListener('click', () => {
            document.getElementById('my-proxy-toolbar').style.display = 'none';
          });
          // simple theme toggle (demo)
          document.getElementById('proxy-theme').addEventListener('click', () => {
            if (document.documentElement.style.filter === 'invert(1)') {
              document.documentElement.style.filter = '';
            } else {
              document.documentElement.style.filter = 'invert(1) hue-rotate(180deg)';
            }
          });
        </script>
      `;

      $('body').prepend(toolbarHtml);

      const outHtml = $.html();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(upstreamRes.status).send(outHtml);
    }

    // Non-HTML: stream binary through
    const buffer = await upstreamRes.arrayBuffer();
    const b = Buffer.from(buffer);
    // copy content-type, content-length, cache-control (if present)
    if (upstreamRes.headers.get("content-type")) {
      res.setHeader("Content-Type", upstreamRes.headers.get("content-type"));
    }
    if (upstreamRes.headers.get("content-length")) {
      res.setHeader("Content-Length", upstreamRes.headers.get("content-length"));
    }
    if (upstreamRes.headers.get("cache-control")) {
      res.setHeader("Cache-Control", upstreamRes.headers.get("cache-control"));
    }
    return res.status(upstreamRes.status).send(b);

  } catch (err) {
    console.error("proxy error:", err);
    return res.status(500).send("Proxy error: " + String(err.message || err));
  }
}
