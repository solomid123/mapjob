import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function jobDetailsFetcher(): Plugin {
  return {
    name: 'job-details-fetcher',
    configureServer(server) {
      server.middlewares.use('/api/fetch-job-details', async (req, res) => {
        try {
          const urlObj = new URL(req.url || '', 'http://localhost');
          const targetUrl = urlObj.searchParams.get('url');
          if (!targetUrl) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
          }

          const response = await fetch(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          });

          if (!response.ok) {
            res.statusCode = response.status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Failed to fetch job page' }));
            return;
          }

          const html = await response.text();
          // 1. Check for Adzuna's adp-body section
          const adpMatch = html.match(/<section[^>]*class="[^"]*adp-body[^"]*"[^>]*>([\s\S]*?)<\/section>/i);
          let rawHtml = '';
          if (adpMatch) {
            rawHtml = adpMatch[1];
          } else {
            // 2. Fallbacks for generic job boards or other classes
            const genericMatch = html.match(/class="[^"]*(?:job-description|description|ad-description)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            if (genericMatch) {
              rawHtml = genericMatch[1];
            }
          }

          let fullText = '';
          if (rawHtml) {
            fullText = rawHtml
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/p>/gi, '\n\n')
              .replace(/<\/li>/gi, '\n')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&#39;/g, "'")
              .replace(/&amp;/g, '&')
              .replace(/&quot;/g, '"')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/[ \t]+/g, ' ')
              .replace(/\n\s+\n/g, '\n\n')
              .trim();
          }

          // 2. Resolve direct external employer career portal URL (bypasses intermediate Adzuna click)
          let directApplyUrl = '';
          try {
            const landMatch = html.match(/href="([^"]*\/land\/ad\/[^"]*)"/i);
            if (landMatch) {
              let landUrl = landMatch[1];
              if (landUrl.startsWith('/')) {
                const parsed = new URL(targetUrl);
                landUrl = `${parsed.origin}${landUrl}`;
              }
              const landRes = await fetch(landUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
              });
              if (landRes.ok) {
                const landHtml = await landRes.text();
                const metaRefresh = landHtml.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']\d+;\s*url=([^"']+)["']/i);
                if (metaRefresh && metaRefresh[1]) {
                  directApplyUrl = metaRefresh[1];
                } else {
                  const locMatch = landHtml.match(/location\.(?:replace|href)\s*=\s*["'](https?:\/\/[^"']+)["']/i);
                  if (locMatch && locMatch[1]) {
                    directApplyUrl = locMatch[1];
                  }
                }
              }
            }
          } catch {
            // fallback
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ 
            fullDescription: fullText,
            directApplyUrl: directApplyUrl || targetUrl
          }));
        } catch (err: any) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), jobDetailsFetcher()],
  server: {
    proxy: {
      '/api/adzuna': {
        target: 'https://api.adzuna.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/adzuna/, ''),
      },
    },
  },
})
