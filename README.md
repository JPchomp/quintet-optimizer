# Quintet Lineup Optimizer

React + Vite + Tailwind. Ready for GitHub Pages.

## Run locally
```bash
npm install
npm run dev
```

## Deploy to GitHub Pages
1. Create a new repo on GitHub (e.g., `quintet-optimizer`). Do **not** add any files.
2. Initialize and push:
   ```bash
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<YOUR_USER>/<YOUR_REPO>.git
   git push -u origin main
   ```
3. In GitHub → Settings → Pages → set "Source" to "GitHub Actions".
4. The included workflow builds on every push to `main` and publishes `dist/` to Pages.

Notes:
- `vite.config.js` uses `base: './'` so assets resolve under Pages.
- No React Router. If you add routes later, add a 404 fallback for GH Pages.
