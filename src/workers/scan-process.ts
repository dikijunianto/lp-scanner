import {createStore} from "../db/store";
import {Scanner} from "./scanner";
const store=createStore();
try {await new Scanner(store,undefined,Number(process.argv[2])).scan();}
finally {store.close();}
