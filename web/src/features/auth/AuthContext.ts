import { createContext } from 'react';
import type { AuthState } from './types';

export interface AuthContextValue extends AuthState {
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const AUTH_LOADING_STATE: AuthState = {
  status: 'loading',
  userId: null,
  profile: null,
  error: null,
};

export const AuthContext = createContext<AuthContextValue | null>(null);
