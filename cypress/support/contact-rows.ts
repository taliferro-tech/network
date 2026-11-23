/**
 * Stands in for todd-backend's GET /network/contact-rows in e2e runs. The
 * dev server talks to the production API, which can't verify an emulator
 * ID token, so this reads the same contacts from the Firestore emulator and
 * reduces them the way the backend does (networkRoutes.js toContactRow).
 * Tests keep seeding contacts with cy.seedContact and see them on the
 * Contacts, Pipeline and Progress pages.
 */
const FIRESTORE = 'http://127.0.0.1:8180/v1/projects/taliferrotech/databases/(default)/documents';

type FirestoreValue = Record<string, any>;

function fromValue ( value: FirestoreValue ): any {
  if ( !value ) return null;
  if ( 'stringValue' in value ) return value['stringValue'];
  if ( 'booleanValue' in value ) return value['booleanValue'];
  if ( 'integerValue' in value ) return Number( value['integerValue'] );
  if ( 'doubleValue' in value ) return value['doubleValue'];
  if ( 'timestampValue' in value ) return value['timestampValue'];
  if ( 'arrayValue' in value ) return ( value['arrayValue'].values || [] ).map( fromValue );
  if ( 'mapValue' in value ) return fromFields( value['mapValue'].fields || {} );
  return null;
}

function fromFields ( fields: Record<string, FirestoreValue> ): Record<string, any> {
  return Object.fromEntries( Object.entries( fields ).map( ( [key, value] ) => [key, fromValue( value )] ) );
}

function toContactRow ( id: string, data: Record<string, any> ): Record<string, unknown> {
  const text = ( value: unknown ) => typeof value === 'string' ? value : '';
  const emails = ( Array.isArray( data['emailAddresses'] ) ? data['emailAddresses'] : [] )
    .filter( ( entry: any ) => entry && text( entry.emailAddress ) )
    .map( ( entry: any ) => entry.blocked === true ? { emailAddress: entry.emailAddress, blocked: true } : { emailAddress: entry.emailAddress } );
  const phones = ( Array.isArray( data['phoneNumbers'] ) ? data['phoneNumbers'] : [] )
    .filter( ( entry: any ) => entry && text( entry.phoneNumber ) )
    .map( ( entry: any ) => ( { phoneNumber: entry.phoneNumber } ) );
  const row: Record<string, unknown> = {
    id, firstName: text( data['firstName'] ), lastName: text( data['lastName'] ), company: { name: text( data['company']?.name ) },
    profession: text( data['profession'] ), status: text( data['status'] ), emailAddresses: emails, phoneNumbers: phones,
  };
  if ( data['emailBlocked'] === true ) row['emailBlocked'] = true;
  if ( data['deleted'] === true ) row['deleted'] = true;
  if ( data['notEngaged'] === true ) row['notEngaged'] = true;
  return row;
}

/** uid from an (unsigned, emulator) ID token. */
function uidOf ( authorization: string ): string {
  try {
    const payload = authorization.replace( /^Bearer\s+/i, '' ).split( '.' )[1];
    const json = JSON.parse( atob( payload.replace( /-/g, '+' ).replace( /_/g, '/' ) ) );
    return String( json.user_id || json.sub || '' );
  } catch {
    return '';
  }
}

async function contactRows ( authorization: string ): Promise<Record<string, unknown>[]> {
  const uid = uidOf( authorization );
  if ( !uid ) return [];
  const headers = { Authorization: authorization };
  // Same tenant rule as the backend: users/{uid}.companyId, else the uid.
  const user = await fetch( `${FIRESTORE}/users/${uid}`, { headers } );
  const companyId = user.ok ? String( fromFields( ( await user.json() ).fields || {} )['companyId'] || '' ).trim() : '';
  const tenantId = companyId || uid;
  const rows: Record<string, unknown>[] = [];
  let pageToken = '';
  do {
    const response = await fetch( `${FIRESTORE}/tenants/${tenantId}/contacts?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers } );
    if ( !response.ok ) break;
    const body = await response.json();
    ( body.documents || [] ).forEach( ( document: any ) => {
      rows.push( toContactRow( String( document.name ).split( '/' ).pop() || '', fromFields( document.fields || {} ) ) );
    } );
    pageToken = body.nextPageToken || '';
  } while ( pageToken );
  return rows;
}

/** The emulator read can drop while a spec reloads the page; try it a few times before failing the test. */
async function withRetry<T> ( read: () => Promise<T>, tries = 4 ): Promise<T> {
  let lastError: unknown;
  for ( let attempt = 0; attempt < tries; attempt++ ) {
    try {
      return await read();
    } catch ( error ) {
      lastError = error;
      await new Promise( ( resolve ) => setTimeout( resolve, 250 * ( attempt + 1 ) ) );
    }
  }
  throw lastError;
}

beforeEach( () => {
  cy.intercept( 'GET', '**/network/contact-rows', ( req ) => {
    const authorization = String( req.headers['authorization'] || '' );
    if ( !authorization ) {
      req.reply( { statusCode: 401, body: { error: 'Missing bearer token.' } } );
      return;
    }
    return withRetry( () => contactRows( authorization ) ).then( ( contacts ) => {
      req.reply( { statusCode: 200, body: { success: true, data: { contacts } } } );
    } );
  } );
} );

export { };
