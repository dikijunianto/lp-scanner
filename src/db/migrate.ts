import { createStore } from "./store";
const store = createStore();
store.close();
console.log("Database migrations applied.");
