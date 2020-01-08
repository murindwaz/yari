const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const chalk = require("chalk");
const cheerio = require("cheerio");
const yaml = require("js-yaml");
const csv = require("@fast-csv/parse");

require("dotenv").config();

const { packageBCD } = require("./resolve-bcd");
const ProgressBar = require("ssr/progress-bar");
const { MIN_GOOGLE_ANALYTICS_PAGEVIEWS } = require("./constants");

function runBuild(options, logger) {
  const { root, destination } = options;
  const builder = new Builder(root, destination, options, logger);

  if (options.googleanalyticsPageviewsCsv) {
    const t0 = new Date();
    builder.initGoogleAnalyticsPageviewsCSV(rowsParsed => {
      const t1 = new Date();
      console.log(
        chalk.green(
          `${rowsParsed.toLocaleString()} rows parsed. ${Object.keys(
            builder.popularities
          ).length.toLocaleString()} popularities found. Took ${ppMilliseconds(
            t1 - t0
          )}.`
        )
      );
      builder.start();
    });
  } else {
    builder.start();
  }
}

// Enums for return values
const processing = Object.freeze({
  ALREADY: "already",
  PROCESSED: "processed",
  EMPTY: "empty",
  EXCLUDED: "excluded"
});

class Builder {
  constructor(root, destination, options, logger) {
    this.root = root;
    this.destination = destination;
    this.options = options;
    this.logger = logger;
    this.selfHash = null;

    this.progressBar = !options.noProgressbar
      ? new ProgressBar({
          includeMemory: true
        })
      : null;

    this.popularities = {};
  }
  initProgressbar(total) {
    this.progressBar && this.progressBar.init(total);
  }
  tickProgressbar(incr) {
    this.progressBar && this.progressBar.update(incr);
  }
  stopProgressbar() {
    this.progressBar && this.progressBar.stop();
  }

  printProcessing(result, fileWritten) {
    !this.progressBar && this.logger.info(`${result}: ${fileWritten}`);
  }

  start() {
    // Just print what could be found and exit
    if (this.options.listLocales) {
      const t0 = new Date();
      Object.entries(this.countLocaleFolders())
        .map(([locale, count]) => {
          return [count, locale];
        })
        .sort((a, b) => b[0] - a[0])
        .forEach(([count, locale]) => {
          console.log(
            `${chalk.green(locale.padStart(6))}: ${count.toLocaleString()}`
          );
        });
      const t1 = new Date();
      console.log(chalk.yellow(`Took ${ppMilliseconds(t1 - t0)}`));
      return;
    }

    // This prepares this.selfHash so that when we build files, we can
    // write down which "self hash" was used at the time.
    this.initSelfHash();

    // To be able to make a progress bar we need to first count what we're
    // going to need to do.
    if (this.progressBar) {
      const countTodo = this.countFolders();
      if (!countTodo) {
        throw new Error("No folders found to process!");
      }
      this.initProgressbar(countTodo);
    }

    // Now do similar to what countFolders() does but actually process each
    let total = 0;

    // Record of counts of all results
    const counts = {};
    Object.values(processing).forEach(key => {
      counts[key] = 0;
    });

    this.prepareRoot();

    const t0 = new Date();
    this.getLocaleRootFolders().forEach(filepath => {
      walker(filepath, (folder, files) => {
        if (this.excludeFolder(folder, filepath, files)) {
          counts[processing.EXCLUDED]++;
          return;
        }
        let wrote;
        let result;
        try {
          [result, wrote] = this.processFolder(folder);
          this.printProcessing(result, wrote);
        } catch (err) {
          // If a crash happens inside processFolder it's hard to debug
          // if you don't know which files/folders caused it. So inject
          // some logging of that before throwing.
          console.error(chalk.yellow(`Error happened processing: ${folder}`));

          // XXX need to decide what to do with errors.
          // We could increment a counter and dump all errors to a log file.
          throw err;
        }
        counts[result]++;
        this.tickProgressbar(++total);
      });
    });
    const t1 = new Date();
    this.summorizeResults(counts, t1 - t0);
  }

  initSelfHash() {
    this.selfHash = makeHash([
      // This'll be different when new packages are changed like
      // `mdn-browser-compat-data` but we *could* be more explicit but
      // this'll be on the safe side.
      path.join(__dirname, "../package.json"),
      // This is broad but let's make it depend on every .js file
      // in this file's folder
      ...fs
        .readdirSync(path.dirname(__filename))
        .filter(name => name.endsWith(".js"))
        .map(name => path.join(path.dirname(__filename), name))
    ]);
  }

  prepareRoot() {
    if (this.options.startClean) {
      // Experimental new feature
      // https://nodejs.org/api/fs.html#fs_fs_rmdirsync_path_options
      fs.rmdirSync(this.options.destination, { recursive: true });
    }
    fs.mkdirSync(this.options.destination, { recursive: true });
  }

  initGoogleAnalyticsPageviewsCSV(done) {
    if (this.options.googleanalyticsPageviewsCsv) {
      const pageviews = {};
      csv
        .parseFile(this.options.googleanalyticsPageviewsCsv, { headers: true })
        .on("error", error => console.error(error))
        .on("data", row => {
          const uri = row.Page;
          const count = parseInt(row.Pageviews);

          if (
            count >= MIN_GOOGLE_ANALYTICS_PAGEVIEWS &&
            uri.includes("/docs/") &&
            !uri.includes("$") &&
            !uri.includes("?")
          ) {
            pageviews[uri] = count;
          }
        })
        .on("end", rowCount => {
          const sumTotal = Object.values(pageviews).reduce((a, b) => a + b);
          if (!sumTotal) {
            throw new Error("No pageviews found!");
          }
          Object.entries(pageviews).forEach(([uri, count]) => {
            // It just needs to be a floating point number.
            // Multiply by 1000 to avoid complicated floating point rounding
            // errors when this eventually gets serialized in JSON.
            this.popularities[uri] = (1000 * count) / sumTotal;
          });
          done(rowCount);
        });
    }
  }

  summorizeResults(counts, took) {
    console.log("\n");
    console.log(
      chalk.green(`Summary of build (locales=${this.options.locales}):`)
    );
    const totalProcessed = counts[processing.PROCESSED];
    // const totalDocuments = Object.values(counts).reduce((a, b) => a + b);
    const rate = (1000 * totalProcessed) / took; // per second
    console.log(
      chalk.yellow(
        `Processed ${totalProcessed.toLocaleString()} in ${ppMilliseconds(
          took
        )} (roughly ${rate.toFixed(1)} docs/sec)`
      )
    );
    Object.keys(counts)
      .sort()
      .map(key => {
        const count = counts[key];
        console.log(`${key.padEnd(12)}: ${count.toLocaleString()}`);
      });
  }

  /** Return true if for any reason this folder should not be processed */
  excludeFolder(folder, localeFolder, files) {
    if (this.options.foldersearch.length) {
      const foldername = folder.replace(localeFolder, "");
      if (
        !this.options.foldersearch.some(search => foldername.includes(search))
      ) {
        return true;
      }
    }

    return !(files.includes("index.html") && files.includes("index.yaml"));
  }

  getLocaleRootFolders() {
    const { locales } = this.options;
    const files = fs.readdirSync(this.root);
    const folders = [];
    for (const name of files) {
      const filepath = path.join(this.root, name);
      const isDirectory = fs.statSync(filepath).isDirectory();
      if (isDirectory && (!locales.length || locales.includes(name))) {
        folders.push(filepath);
      }
    }
    return folders;
  }

  countFolders() {
    let folders = 0;
    this.getLocaleRootFolders().forEach(filepath => {
      walker(filepath, (_, files) => {
        if (files.includes("index.html") && files.includes("index.yaml")) {
          folders++;
        }
      });
    });
    return folders;
  }

  countLocaleFolders() {
    let locales = {};
    this.getLocaleRootFolders().forEach(filepath => {
      const locale = path.basename(filepath);
      if (!(locale in locales)) {
        locales[locale] = 0;
      }
      walker(filepath, (folder, files) => {
        if (files.includes("index.html") && files.includes("index.yaml")) {
          if (this.excludeFolder(folder, filepath, files)) {
            return;
          }
          locales[locale]++;
        }
      });
    });
    return locales;
  }

  excludeSlug(metadata) {
    const { slugsearch } = this.options;
    if (slugsearch.length) {
      const { mdn_url } = metadata;
      return slugsearch.some(search => mdn_url.includes(search));
    }
    return false;
  }

  processFolder(folder) {
    const hasher = crypto.createHash("md5");
    const doc = {};
    const metadataRaw = fs.readFileSync(path.join(folder, "index.yaml"));
    hasher.update(metadataRaw);
    const metadata = yaml.safeLoad(metadataRaw);
    const { slugsearch } = this.options;
    if (slugsearch.length) {
      // Only bother if this document's slug matches
      if (this.excludeSlug(metadata)) {
        return [processing.EXCLUDED, null];
      }
    }
    // The destination is the same as source but with a different base.
    // If the file *came from* /path/to/files/en-US/foo/bar/
    // the final destination is /path/to/build/en-US/foo/bar/index.json
    const destination = path.join(
      folder.replace(this.root, this.destination),
      "index.json"
    );
    const hashDestination = path.join(
      folder.replace(this.root, this.destination),
      "index.hash"
    );

    // When the KS thing works we won't need this line

    // // REAL
    // const rawHtml = fs.readFileSync(path.join(folder, "index.html"), "utf8");
    // hasher.update(rawHtml);
    // const renderedHtml = this.renderHtml(rawHtml, metadata);
    // FAKE (NOTE, the docHash check stuff needs to happen BEFORE executing renderHtml)
    // const rawHtml = fs.readFileSync(path.join(folder, "raw.html"), "utf8");
    const renderedHtml = fs.readFileSync(
      path.join(folder, "index.html"),
      "utf8"
    );
    hasher.update(renderedHtml);

    // Now we've read in all the "inputs" needed.
    const docHash = hasher.digest("hex").slice(0, 12);
    const combinedHash = `${this.selfHash}.${docHash}`;
    // If the destination and the hash file already exists AND the content
    // of an existing hash file is the same as this `combinedHash` then we
    // can bail early.
    if (
      !this.options.noCache &&
      fs.existsSync(destination) &&
      fs.existsSync(hashDestination) &&
      fs.readFileSync(hashDestination, "utf8") === combinedHash
    ) {
      return [processing.ALREADY, destination];
    }

    const $ = cheerio.load(`<div id="_body">${renderedHtml}</div>`, {
      decodeEntities: false
    });

    // Remove those '<span class="alllinks"><a href="/en-US/docs/tag/Web">View All...</a></span>' links
    // Remove any completely empty <p>, <dl>, or <div> tags.
    // XXX costs about 5% longer time
    // $("p:empty,dl:empty,div:empty,span.alllinks").remove();

    // let macroCalls = extractMacroCalls(rawHtml);

    // Note that 'extractSidebar' will always return a string.
    // And if it finds a sidebar section, it gets removed from '$' too.
    doc.sidebarHTML = extractSidebar($);

    const sections = [];
    let section = cheerio
      .load("<div></div>", { decodeEntities: false })("div")
      .eq(0);

    const iterable = [...$("#_body")[0].childNodes];

    let c = 0;
    iterable.forEach(child => {
      if (child.tagName === "h2") {
        if (c) {
          sections.push(...addSections(section.clone()));
          section.empty();
        }
        c = 0;
      }
      // We *could* wrap this in something like `if (child.tagName) {`
      // which would exclude any node that isn't a tag, such as jed comments.
      // That might make the DOM nodes more compact and memory efficient.
      c++;
      section.append(child);
    });
    if (c) {
      // last straggler
      sections.push(...addSections(section));
    }

    doc.title = metadata.title;
    doc.mdn_url = metadata.mdn_url;
    doc.body = sections;
    doc.popularity = this.popularities[doc.mdn_url] || 0.0;

    doc.last_modified = metadata.modified;
    const destDir = path.dirname(destination);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(doc, null, 2));
    fs.writeFileSync(hashDestination, combinedHash);
    return [processing.PROCESSED, destination];
  }

  renderHtml(rawHtml, metadata) {
    // XXX Ryan! This is where we need that sweet KumaScript action!
    throw new Error("under construction");
  }
}

function walker(root, callback) {
  const files = fs.readdirSync(root);
  for (const name of files) {
    const filepath = path.join(root, name);
    const isDirectory = fs.statSync(filepath).isDirectory();
    if (isDirectory) {
      callback(
        filepath,
        fs.readdirSync(filepath).filter(name => {
          return !fs.statSync(path.join(filepath, name)).isDirectory();
        })
      );
      // Now go deeper
      walker(filepath, callback);
    }
  }
}

/** Extract and mutate the $ if it as a "Quick_Links" section */
function extractSidebar($) {
  const search = $("#Quick_Links");
  if (!search.length) {
    return "";
  }
  const sidebarHtml = search.html();
  search.remove();
  return sidebarHtml;
}

/** Return an array of new sections to be added to the complete document.
 *
 * Generally, this function is called with a cheerio (`$`) section that
 * has HTML in it. The task is to structure that a little bit.
 * If the HTML inside the '$' is:
 *
 *   <h2 id="foo">Foo</h2>
 *   <p>Bla bla</p>
 *   <ul><li>One</li></ul>
 *
 * then, the expected output is to return:
 *
 *   [{
 *       type: "prose",
 *       id: "foo",
 *       title: "Foo"
 *       content: "<p>Bla bla<p>\n<ul><li>One</li></ul>"
 *   }]
 *
 * The reason it's always returning an array is because of special
 * sections. A special section is one where we try to transform it
 * first. For example BCD tables. If the input is this:
 *
 *   <h2 id="browser_compat">Browser Compat</h2>
 *   <div class="bc-data" id="bcd:foo.bar.thing">...</div>
 *
 * Then, extract the ID, get the structured data and eventually return this:
 *
 *   [{
 *     type: "browser_compatibility",
 *     value: {
 *        query: "foo.bar.thing",
 *        id: "browser_compat",
 *        title: "Browser Compat",
 *        data: {....}
 *   }]
 *
 * At the time of writing (Jan 2020), there is only one single special type of
 * section and that's BCD. The idea is we look for a bunch of special sections
 * and if all else fails, just leave it as HTML as is.
 */
function addSections($) {
  if ($.find("div.bc-data").length) {
    /** If there's exactly 1 BCD table the only section to add is something
     * like this:
     *    {
     *     "type": "browser_compatibility",
     *     "value": {
     *       "title": "Browser compatibility",
     *       "id": "browser_compatibility",
     *        "query": "html.elements.video",
     *        "data": {....}
     *    }
     *
     * Where the 'title' and 'id' values comes from the <h2> tag (if available).
     *
     * However, if there are **multiple BCD tables**, which is rare, the it
     * needs to return something like this:
     *
     *   [{
     *     "type": "prose",
     *     "value": {
     *       "id": "browser_compatibility",
     *       "title": "Browser compatibility"
     *       "content": "Possible stuff before the table"
     *    },
     *    {
     *     "type": "browser_compatibility",
     *     "value": {
     *        "query": "html.elements.video",
     *        "data": {....
     *    },
     *   {
     *     "type": "prose",
     *     "value": {
     *       "content": "Any other stuff before table maybe"
     *    },
     */
    // if (macroCalls.Compat.length > 1) {
    if ($.find("div.bc-data").length > 1) {
      const subSections = [];
      let section = cheerio
        .load("<div></div>", { decodeEntities: false })("div")
        .eq(0);

      // Loop over each and every "root element" in the node and keep piling
      // them up in a buffer, until you encounter a `div.bc-table` then
      // add that to the stack, clear and repeat.
      let iterable = [...$[0].childNodes];
      let c = 0;
      iterable.forEach(child => {
        if (
          child.tagName === "div" &&
          child.attribs &&
          child.attribs.class &&
          /bc-data/.test(child.attribs.class)
        ) {
          if (c) {
            subSections.push(..._addSectionProse(section.clone()));
            section.empty();
            c = 0; // reset the counter
          }
          section.append(child);
          subSections.push(..._addSingleSectionBCD(section.clone()));
          section.empty();
        } else {
          section.append(child);
          c++;
        }
      });
      if (c) {
        subSections.push(..._addSectionProse(section.clone()));
      }
      return subSections;
    } else {
      return _addSingleSectionBCD($);
    }
  }

  // all else, leave as is
  return _addSectionProse($);
}

function _addSingleSectionBCD($) {
  let id = null;
  let title = null;

  const h2s = $.find("h2");
  if (h2s.length === 1) {
    id = h2s.attr("id");
    title = h2s.text();
  }

  const dataQuery = $.find("div.bc-data").attr("id");
  // Some old legacy documents haven't been re-rendered yet, since it
  // was added, so the `div.bc-data` tag doesn't have a `id="bcd:..."`
  // attribute. If that's the case, bail and fail back on a regular
  // prose section :(
  if (!dataQuery) {
    // I wish there was a good place to log this!
    return _addSectionProse($);
  }
  const query = dataQuery.replace(/^bcd:/, "");
  const data = packageBCD(query);
  return [
    {
      type: "browser_compatibility",
      value: {
        title,
        id,
        data,
        query
      }
    }
  ];
}

function _addSectionProse($) {
  let id = null;
  let title = null;
  // Maybe this should check that the h2 is first??
  const h2s = $.find("h2");
  if (h2s.length === 1) {
    id = h2s.attr("id");
    title = h2s.text();
    // XXX Maybe this is a bad idea.
    // See https://wiki.developer.mozilla.org/en-US/docs/MDN/Contribute/Structures/Page_types/API_reference_page_template
    // where the <h2> needs to be INSIDE the `<div class="note">`.
    h2s.remove();
    // } else if (h2s.length > 1) {
    //     throw new Error("Too many H2 tags");
  }

  return [
    {
      type: "prose",
      value: {
        id,
        title,
        content: $.html().trim()
      }
    }
  ];
}

// function extractMacroCalls(text) {
//   const RECOGNIZED_MACRO_NAMES = ["Compat"];

//   function evaluateMacroArgs(argsString) {
//     if (argsString.startsWith("{") && argsString.endsWith("}")) {
//       return JSON.parse(argsString);
//     }
//     if (argsString.includes(",")) {
//       return eval(`[${argsString}]`);
//     }
//     // XXX A proper parser instead??
//     return eval(argsString);
//   }

//   const calls = {};
//   /**
//    * Note that the text can have escaped macros. For example:
//    *
//    *    This is how you write a macros: \{{Compat("foo.bar")}}
//    *
//    */
//   const matches = text.matchAll(/[^\\]{{\s*(\w+)\s*\((.*?)\)\s*}}/g);
//   for (const match of matches) {
//     const macroName = match[1];
//     if (RECOGNIZED_MACRO_NAMES.includes(macroName)) {
//       if (!calls[macroName]) {
//         calls[macroName] = [];
//       }
//       const macroArgs = evaluateMacroArgs(match[2].trim());
//       calls[macroName].push(macroArgs);
//     }
//   }
//   return calls;
// }

function ppMilliseconds(ms) {
  // If the number of millseconds is really large, use seconds. Or minutes
  // even.
  if (ms > 1000 * 60 * 5) {
    const seconds = ms / 1000;
    const minutes = seconds / 60;
    return `${minutes.toFixed(1)} minutes`;
  } else if (ms > 1000) {
    const seconds = ms / 1000;
    return `${seconds.toFixed(1)} seconds`;
  } else {
    return `${ms.toFixed(1)} milliseconds`;
  }
}

function makeHash(filepaths, length = 12) {
  const hasher = crypto.createHash("md5");
  filepaths
    .map(fp => fs.readFileSync(fp, "utf8"))
    .forEach(content => hasher.update(content));
  return hasher.digest("hex").slice(0, length);
}
module.exports = {
  runBuild
};