// API contracts. Mirror of shared/schema.json — change that file first, then this one and backend/app/contracts.py.

export type Item = {
  id: string;
  title: string;
  done: boolean;
};

export type ItemCreate = {
  title: string;
};
