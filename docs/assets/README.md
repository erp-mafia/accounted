# Repository artwork

`social-preview.svg` is the editable source for the repository's social preview. `social-preview.png` is its 1280 x 640 export, ready for GitHub's Settings > General > Social preview upload.

The artwork uses the project's existing neutral palette and wordmark treatment. It contains no customer data and does not depict an application screen. The README uses the existing Accounted app icon from `public/accounted-icon.png` above its title.

`app-vouchers.png` is the screenshot in the README: the vouchers list of the simulated company that `npm run local:up -- --sim` builds, in the English interface at 1440 x 900. Every name and amount in it is generated; it contains no customer data. To retake it, start the local stack with `--sim`, sign in as the seeded user and capture `/bookkeeping`.

When updating the artwork, keep the SVG and PNG in sync. Render the SVG at its intrinsic size and inspect the exported image before publishing it.
