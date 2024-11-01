#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import splitTiff from "./index.js";

const input = process.argv[2];

if (!input) {
  console.log(`Usage:\n\n    split-tiff [input.tiff]\n`);
} else {
  const { name, ext } = path.parse(input);
  let i = 0;
  for (const tiff of splitTiff(fs.readFileSync(input))) {
    const filename = `${name}-${++i}${ext}`;
    console.log(filename);
    fs.writeFileSync(filename, tiff);
  }
}
