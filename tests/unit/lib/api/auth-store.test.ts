import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractAuthFromPage } from '../../../../lib/api/auth-store';

function clearCookies() {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

beforeEach(() => {
  clearCookies();
  localStorage.clear();
});

afterEach(() => {
  clearCookies();
  localStorage.clear();
});

describe('extractAuthFromPage', () => {
  it('returns null when the JWT cookie is missing', () => {
    localStorage.setItem('Bigmodel-Organization', 'org-1');
    localStorage.setItem('Bigmodel-Project', 'proj-1');
    expect(extractAuthFromPage()).toBeNull();
  });

  it('returns null when org/project are missing', () => {
    document.cookie = 'bigmodel_token_production=rawjwt';
    expect(extractAuthFromPage()).toBeNull();
  });

  it('normalizes a bare JWT to a Bearer token', () => {
    document.cookie = 'bigmodel_token_production=rawjwt';
    localStorage.setItem('Bigmodel-Organization', 'org-1');
    localStorage.setItem('Bigmodel-Project', 'proj-1');

    expect(extractAuthFromPage()).toEqual({
      authorization: 'Bearer rawjwt',
      bigmodelOrganization: 'org-1',
      bigmodelProject: 'proj-1',
    });
  });

  it('preserves an already-prefixed Bearer token', () => {
    document.cookie = 'bigmodel_token_production=Bearer alreadyjwt';
    localStorage.setItem('Bigmodel-Organization', 'org-2');
    localStorage.setItem('Bigmodel-Project', 'proj-2');

    expect(extractAuthFromPage()?.authorization).toBe('Bearer alreadyjwt');
  });
});
