<div align="center">
  <img src="assets/cosmic-banner.svg" alt="KAELITH69 Cosmic Journey" width="100%">
</div>

# KAELITH69 Cosmic Journey

An interactive Three.js portfolio that turns a solar system exploration into a home for selected software projects. The scene remains active behind the portfolio, with scroll driven camera movement and direct planet selection.

**[Open the live portfolio](https://kaelith69.github.io/kaelith69-cosmic-journey/)**

## Experience

- **Solar system scene:** Nine celestial bodies, orbital paths, a star field, planetary textures and Saturn's rings.
- **Scroll driven camera:** The camera moves from a system overview towards Earth as the page is explored.
- **Planet focus:** Select a planet to move the camera towards it. Select it again to return to the scroll journey.
- **Orbit speed:** Adjust or pause the simulation with the speed control.
- **Portfolio sections:** Selected projects, a concise overview of the work and contact links.
- **Responsive layout:** Navigation, project layouts and orbital controls adapt to smaller screens.
- **Reduced motion:** The orbital simulation starts paused when the operating system requests reduced motion.

## Built with

- HTML
- CSS
- JavaScript ES modules
- [Three.js](https://threejs.org/) 0.164.1, loaded from jsDelivr
- Planet textures from [Solar System Scope](https://www.solarsystemscope.com/textures/)

There is no package manifest, build pipeline or application framework. The site is a static page.

## Run locally

A local HTTP server is required because the page imports Three.js as an ES module.

```bash
git clone https://github.com/Kaelith69/kaelith69-cosmic-journey.git
cd kaelith69-cosmic-journey
python -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000).

The browser needs WebGL support and an internet connection to load Three.js and the external planet textures.

## Project structure

```text
.
├── .github/
│   └── workflows/
│       └── pages.yml
├── assets/
│   └── cosmic-banner.svg
├── index.html
├── QA_REPORT.md
└── README.md
```

## Deployment

GitHub Actions deploys the repository root to GitHub Pages when changes are pushed to `main`. The workflow is defined in [pages.yml](.github/workflows/pages.yml).

## Known limitations

- Planet textures are fetched from an external host. If those requests fail, the scene may render without the intended surface maps.
- The Earth approach is a cinematic camera movement, not a high resolution geographic or satellite imagery zoom.
- The portfolio currently links to selected public repositories and the GitHub and Instagram profiles. It does not include a contact form or backend.
- No licence file is currently present in the repository.
