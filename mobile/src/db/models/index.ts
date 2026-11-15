import type { Model } from "../model.ts";
import {
	BatchKnown,
	CatalogGeneration,
	CatalogScope,
	Item,
	ItemAttr,
	ItemBarcode,
	SerialKnown,
} from "./catalog.ts";
import { DeviceMeta, Outbox, Sale, SampleTxn } from "./transactions.ts";

/** Every table the app owns. Add a class here when you add a table. */
export const ALL_MODELS: Model[] = [
	new CatalogScope(),
	new CatalogGeneration(),
	new Item(),
	new ItemBarcode(),
	new ItemAttr(),
	new SerialKnown(),
	new BatchKnown(),
	new SampleTxn(),
	new Sale(),
	new Outbox(),
	new DeviceMeta(),
];
