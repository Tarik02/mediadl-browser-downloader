import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { defer } from 'radash';

chromium.use(stealth());

const stdin = await fs.promises.open('/dev/stdin', 'r');
const request = JSON.parse(
    (await fs.promises.readFile(stdin)).toString('utf-8')
);
await stdin.close();

const {
    title, filename, body
} = await defer(async register => {
    const browser = await chromium.launch();
    register(async () => await browser.close());

    const context = await browser.newContext();
    register(async () => await context.close());

    const [title, url] = await defer(async register => {
        const page = await context.newPage();
        register(async () => await page.close());

        await page.goto(request.address, {
            waitUntil: 'networkidle',
        });

        return await Promise.all([
            page.title(),
            page.locator('video').first().evaluate(
                /** @param {HTMLVideoElement} $video */
                async $video => {
                    const [ source ] = [
                        $video.src,
                        ...Array.from($video.querySelectorAll('source[type="video/mp4"]'))
                            .map(
                                /** @param {HTMLSourceElement} $source */
                                $source => $source.src
                            ),
                        ...Array.from($video.querySelectorAll('source:not([type="video/mp4"])'))
                            .map(
                                /** @param {HTMLSourceElement} $source */
                                $source => $source.src
                            ),
                    ].filter(value => !! value);

                    if (! source) {
                        throw new Error('No source found');
                    }

                    const $a = document.createElement('a');
                    $a.href = source;
                    $a.download = source;
                    $a.id = 'mediadl-download';
                    document.body.appendChild($a);

                    return source;
                },
            ),
        ]);
    });

    process.stderr.write(`Found url ${ JSON.stringify(url) }. Preparing for downloading\n`);

    const [filename, body] = await defer(async register => {
        const page = await context.newPage();
        register(async () => await page.close());

        const [ request ] = await Promise.all([
            page.waitForRequest(
                async request => {
                    try {
                        return (await request.response())?.ok();
                    } catch {
                        return false;
                    }
                }
            ),
            page.goto(url),
        ]);

        const response = await page.request.get(url, {
            headers: request.headers(),
        });

        const body = await response.body();

        const filename = path.basename(
            response.headers()['content-disposition']?.match(/filename="([^"]+)"/)?.[1]
                ?? (new URL(url)).pathname
        );

        return [filename, body];
    });

    return {
        title,
        filename,
        body,
    }
});

const outputFile = path.join(request.directory, filename);

await Promise.all([
    fs.promises.writeFile(
        outputFile,
        body,
    ),
    new Promise((resolve, reject) => {
        process.stdout.write(JSON.stringify({
            title,
            output: outputFile,
        }), err => err ? reject(err) : resolve());
    }),
]);
