"""Shared constants for sandbox providers and PTCSandbox.

NOTE: `Dockerfile.sandbox` (the Docker provider's image) hand-mirrors
`DEFAULT_DEPENDENCIES`, `SANDBOX_NODE_VERSION` and `SANDBOX_IMAGE_ENV` below; it
cannot import this module at build time. Keep both in sync when editing either.
"""

SNAPSHOT_PYTHON_VERSION = "3.12"  # Intentionally pinned for stability/compatibility.
SANDBOX_NODE_VERSION = "24.14.1"  # Pinned; mirrored in Dockerfile.sandbox.

# Environment every sandbox process needs, delivered twice on purpose: baked
# into the snapshot image, and injected again as per-sandbox env vars at create
# time. The image layer alone is not enough, since a snapshot is reused whenever its
# config hash is unchanged, so a sandbox can be born on an image built before
# one of these was added. The create-time injection reaches those too.
# Commands run as non-login, non-interactive shells that inherit PID 1's
# environment, so /etc/profile.d would not be read; this is the only path.
SANDBOX_IMAGE_ENV = {
    # One Playwright browser dir shared by the npm-side `playwright` (npx) and
    # the Python `playwright` that Scrapling drives, instead of the per-user
    # ~/.cache default the two disagree on.
    "PLAYWRIGHT_BROWSERS_PATH": "/usr/local/ms-playwright",
    # `npm install -g` puts docx and pptxgenjs in the global tree, which Node
    # never searches: resolution only walks node_modules up from the script, so
    # `require("pptxgenjs")` from /home/workspace misses without this.
    "NODE_PATH": "/usr/local/lib/node_modules",
}

DEFAULT_DEPENDENCIES = [
    # Core
    # Exact pin, never a range: mcp_setup joins this list into a shell
    # command, where "<" would parse as a redirect.
    "mcp==2.0.0",
    "fastapi",
    "pandas",
    "requests",
    "aiohttp",
    "httpx[http2]",
    # Data science
    "numpy",
    "scipy",
    "scikit-learn",
    "statsmodels",
    # Financial data
    "yfinance",
    # Visualization
    "matplotlib",
    "seaborn",
    "plotly",
    # Image analysis
    "pillow",
    "opencv-python-headless",
    "scikit-image",
    # File formats
    "openpyxl",
    "xlrd",
    "python-docx",
    "pypdf",
    "beautifulsoup4",
    "lxml",
    "pyyaml",
    # Office skill dependencies
    "defusedxml",
    "pdfplumber",
    "reportlab",
    "python-pptx",
    "ironcalc",
    "firecrawl-anydoc",
    "markitdown[docx,pptx,xlsx]",
    # Web scraping
    "scrapling[all]",
    "html-to-markdown",
    "trafilatura",
    "youtube-transcript-api",
    # Browser automation
    "playwright",
    # Utilities
    "tqdm",
    "tabulate",
]
