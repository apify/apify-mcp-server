## Apify Model Context Protocol (MCP) Server

A template for scraping data from a single web page in TypeScript (Node.js). The URL of the web page is passed in via input, which is defined by the [input schema](https://docs.apify.com/platform/actors/development/input-schema). The template uses the [Axios client](https://axios-http.com/docs/intro) to get the HTML of the page and the [Cheerio library](https://cheerio.js.org/) to parse the data from it. The data are then stored in a [dataset](https://docs.apify.com/sdk/js/docs/guides/result-storage#dataset) where you can easily access them.

The scraped data in this template are page headings but you can easily edit the code to scrape whatever you want from the page.

## Included features

- **[Apify SDK](https://docs.apify.com/sdk/js/)** - a toolkit for building [Actors](https://apify.com/actors)
- **[Input schema](https://docs.apify.com/platform/actors/development/input-schema)** - define and easily validate a schema for your Actor's input
- **[Dataset](https://docs.apify.com/sdk/js/docs/guides/result-storage#dataset)** - store structured data where each object stored has the same attributes
- **[Axios client](https://axios-http.com/docs/intro)** - promise-based HTTP Client for Node.js and the browser
- **[Cheerio](https://cheerio.js.org/)** - library for parsing and manipulating HTML and XML

## How it works

1. `Actor.getInput()` gets the input where the page URL is defined
2. `axios.get(url)` fetches the page
3. `cheerio.load(response.data)` loads the page data and enables parsing the headings
4. This parses the headings from the page and here you can edit the code to parse whatever you need from the page

   ```javascript
   $("h1, h2, h3, h4, h5, h6").each((_i, element) => {...});
   ```

5. `Actor.pushData(headings)` stores the headings in the dataset

## Resources

- [Web scraping in Node.js with Axios and Cheerio](https://blog.apify.com/web-scraping-with-axios-and-cheerio/)
- [Web scraping with Cheerio in 2023](https://blog.apify.com/web-scraping-with-cheerio/)
- [Video tutorial](https://www.youtube.com/watch?v=yTRHomGg9uQ) on building a scraper using CheerioCrawler
- [Written tutorial](https://docs.apify.com/academy/web-scraping-for-beginners/challenge) on building a scraper using CheerioCrawler
- [Integration with Zapier](https://apify.com/integrations), Make, Google Drive, and others
- [Video guide on getting scraped data using Apify API](https://www.youtube.com/watch?v=ViYYDHSBAKM)
- A short guide on how to build web scrapers using code templates:

[web scraper template](https://www.youtube.com/watch?v=u-i-Korzf8w)

## Getting started

For complete information [see this article](https://docs.apify.com/platform/actors/development#build-actor-locally). To run the actor use the following command:

```bash
apify run
```

## Deploy to Apify

### Connect Git repository to Apify

If you've created a Git repository for the project, you can easily connect to Apify:

1. Go to [Actor creation page](https://console.apify.com/actors/new)
2. Click on **Link Git Repository** button

### Push project on your local machine to Apify

You can also deploy the project on your local machine to Apify without the need for the Git repository.

1. Log in to Apify. You will need to provide your [Apify API Token](https://console.apify.com/account/integrations) to complete this action.

   ```bash
   apify login
   ```

2. Deploy your Actor. This command will deploy and build the Actor on the Apify Platform. You can find your newly created Actor under [Actors -> My Actors](https://console.apify.com/actors?tab=my).

   ```bash
   apify push
   ```

## Documentation reference

To learn more about Apify and Actors, take a look at the following resources:

- [Apify SDK for JavaScript documentation](https://docs.apify.com/sdk/js)
- [Apify SDK for Python documentation](https://docs.apify.com/sdk/python)
- [Apify Platform documentation](https://docs.apify.com/platform)
- [Join our developer community on Discord](https://discord.com/invite/jyEM2PRvMU)
