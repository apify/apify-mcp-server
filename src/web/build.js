import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import autoprefixer from 'autoprefixer';
import * as esbuild from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const filename = fileURLToPath(import.meta.url);
const dirName = dirname(filename);

const widgets = [
    { name: 'search-actors-widget', entry: 'src/widgets/search-actors-widget.tsx' },
    { name: 'actor-run-widget', entry: 'src/widgets/actor-run-widget.tsx' },
];

// Check if we're in dev mode
const isDev = process.argv.includes('--watch');

// Plugin to process and inline CSS with Tailwind
const inlineCssPlugin = {
    name: 'inline-css',
    setup(build) {
        build.onLoad({ filter: /\.css$/ }, async (args) => {
            const cssContent = await fs.readFile(args.path, 'utf8');

            // Process CSS through PostCSS with Tailwind
            const result = await postcss([
                tailwindcss,
                autoprefixer,
            ]).process(cssContent, {
                from: args.path,
                to: undefined,
            });

            const processedCss = result.css;

            // Return processed CSS as a JS module that injects it into the document
            return {
                contents: `
          const css = ${JSON.stringify(processedCss)};
          if (typeof document !== 'undefined') {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
          }
          export default css;
        `,
                loader: 'js',
            };
        });
    },
};

async function buildWidget(widget, watch = false) {
    console.log(`${watch ? 'Watching' : 'Building'} ${widget.name}...`);

    const buildOptions = {
        entryPoints: [resolve(dirName, widget.entry)],
        bundle: true,
        minify: !watch,
        format: 'esm',
        target: 'es2020',
        outfile: resolve(dirName, 'dist', `${widget.name}.js`),
        plugins: [inlineCssPlugin],
        define: {
            'process.env.NODE_ENV': watch ? '"development"' : '"production"',
        },
        loader: {
            '.tsx': 'tsx',
            '.ts': 'ts',
        },
        logLevel: 'info',
        sourcemap: watch ? 'inline' : false,
    };

    try {
        if (watch) {
            const context = await esbuild.context(buildOptions);
            await context.watch();
            console.log(`👀 Watching ${widget.name} for changes...`);
            return context;
        }
        await esbuild.build(buildOptions);
        console.log(`✓ ${widget.name} built successfully`);
    } catch (error) {
        console.error(`Failed to build ${widget.name}:`, error);
        throw error;
    }
}

async function buildAll() {
    // Clean and create dist folder
    const distPath = resolve(dirName, 'dist');
    try {
        await fs.rm(distPath, { recursive: true, force: true });
    } catch (err) {
    // Ignore if doesn't exist
    }
    await fs.mkdir(distPath, { recursive: true });

    if (isDev) {
        console.log('🚀 Starting development mode...\n');

        // Build and watch all widgets
        const contexts = [];
        for (const widget of widgets) {
            const ctx = await buildWidget(widget, true);
            contexts.push(ctx);
        }

        // Start a simple HTTP server using esbuild's serve
        const ctx = await esbuild.context({
            entryPoints: [],
        });

        const { host, port } = await ctx.serve({
            servedir: dirName,
            port: 3000,
        });

        console.log(`\n✓ Dev server running at http://${host}:${port}/`);
        console.log(`📄 Open http://${host}:${port}/index.html to preview\n`);

        // Keep the process running
        process.on('SIGINT', async () => {
            console.log('\n\n👋 Shutting down...');
            await ctx.dispose();
            for (const c of contexts) {
                await c.dispose();
            }
            process.exit(0);
        });
    } else {
    // Production build
        for (const widget of widgets) {
            await buildWidget(widget, false);
        }
        console.log('\n✓ All widgets built successfully!');
    }
}

buildAll().catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
});
