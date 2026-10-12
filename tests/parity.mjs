// Calcule des itinéraires avec le moteur JavaScript, pour comparaison avec le Python.
// Usage : node parity.mjs <reseau.json> <cas.json>   -> résultats JSON sur la sortie standard
import {readFileSync} from "node:fs";
import {computeRoutes, loadNetwork, RoutingError} from "../js/routing.js";

const [netPath, casesPath] = process.argv.slice(2);
const net = loadNetwork(JSON.parse(readFileSync(netPath, "utf8")));
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const results = cases.map(c => {
  try {
    return computeRoutes(net, c.request, c.reports || []);
  } catch (e) {
    if (e instanceof RoutingError) return {error: e.message};
    throw e;
  }
});
process.stdout.write(JSON.stringify(results));
