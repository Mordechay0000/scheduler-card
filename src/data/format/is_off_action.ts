import { Action } from "../../types";
import { computeEntity } from "../../lib/entity";

export const isOffAction = (action: Action): boolean => {
  if (computeEntity(action.service) === 'turn_off') return true;
  if (action.service_data?.state === 'off') return true;
  return false;
};

export const isOnAction = (action: Action): boolean => {
  if (computeEntity(action.service) === 'turn_on') return true;
  if (action.service_data?.state === 'on') return true;
  return false;
};
