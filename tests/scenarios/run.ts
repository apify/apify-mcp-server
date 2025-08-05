/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

async function runInput(input: string): Promise<string> {
    console.log('Running scenario input...');
    return new Promise((resolve) => {
        let output = '';
        const child = spawn('q', ['chat', '-a', '--no-interactive', String(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (data) => {
            process.stdout.write(data);
            output += data.toString();
        });
        child.stderr.on('data', (data) => {
            process.stderr.write(data);
            output += data.toString();
        });
        child.on('close', () => {
            resolve(output);
        });
    });
}

async function runEvalWithOutput(requirements: string[], scenarioOutput: string): Promise<boolean> {
    console.log('Evaluating scenario requirements...');
    const evalPrompt = [
        `You are an Apify MCP tester bot. Your job is to run a test scenario and verify if the requirements were met and then mark the test as OK or FAILED. When you finish the testing you need to output final verdict in the format:`,
        '```',
        'VERDICT: OK',
        'or',
        'VERDICT: FAILED',
        '```',
        '',
        'Scenario output:',
        '```',
        scenarioOutput,
        '```',
        '',
        'Requirements:',
        ...requirements.map((r) => `- ${r}`),
        '',
        'Evaluate the scenario output above if it meets the requirements.',
    ].join('\n');
    return new Promise((resolve) => {
        let output = '';
        const child = spawn('q', ['chat', '-a', '--no-interactive', evalPrompt], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (data) => {
            process.stdout.write(data);
            output += data.toString();
        });
        child.stderr.on('data', (data) => {
            process.stderr.write(data);
            output += data.toString();
        });
        child.on('close', () => {
            if (/VERDICT:\s*OK/.test(output)) {
                console.log('VERDICT: OK');
                resolve(true);
            } else if (/VERDICT:\s*FAILED/.test(output)) {
                console.log('VERDICT: FAILED');
                resolve(false);
            } else {
                console.log('VERDICT: Not found in output, treating as FAILED');
                resolve(false);
            }
        });
    });
}

async function main() {
    const scenarioPath = process.argv[2];
    if (!scenarioPath) {
        process.stderr.write('Usage: node run.js <scenario-file>\n');
        process.exit(1);
    }
    console.log(`Reading scenario from: ${scenarioPath}`);
    const content = fs.readFileSync(scenarioPath, 'utf-8');
    const json = JSON.parse(content);
    const scenarioInput = json.input;
    const { requirements } = json;
    const scenarioOutput = await runInput(scenarioInput);
    const ok = await runEvalWithOutput(requirements, scenarioOutput);
    if (ok) {
        console.log('Scenario PASSED.');
    } else {
        console.log('Scenario FAILED.');
    }
    process.exit(ok ? 0 : 1);
}

await main();
