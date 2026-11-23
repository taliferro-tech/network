import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule, Router } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { Subscription, combineLatest } from 'rxjs';
import { environment } from '../../../environments/environment';
import { NetworkAuthService } from '../../services/network-auth.service';
import { NetworkDataService } from '../../services/network-data.service';
import { NetworkContactStateService } from '../../services/network-contact-state.service';
import { NetworkAssistantSignalService } from '../../services/network-assistant-signal.service';
import { Contact } from '../../models/contact.model';
import { BackToTopComponent } from '../../shared/back-to-top/back-to-top.component';
import { PreloaderComponent } from '../../shared/preloader/preloader.component';
import { StatusFlowComponent } from '../../shared/status-flow/status-flow.component';
import { stageTint } from '../../shared/stage-tint';
import { WriteActionDirective } from '../../shared/write-access/write-action.directive';
import { EmptyStateComponent } from '../../shared/empty-state/empty-state.component';
import { OutreachLinkService } from '../../services/outreach-link.service';

type ContactSortKey = 'name' | 'company' | 'email' | 'phone' | 'status';
type SortDirection = 'asc' | 'desc';
/** all, nobody can email them, or TODD/auto-cleanup marked them Deleted. */
type ContactView = 'all' | 'cantEmail' | 'marked';

/** One contact with everything its row shows worked out once, not per redraw. */
export interface ContactRow {
  contact: Contact;
  id: string;
  name: string;
  initial: string;
  company: string;
  email: string;
  phone: string;
  tint: string | null;
  self: boolean;
  canEmail: boolean;
  cantEmail: boolean;
  marked: boolean;
  /** Lowercased name, company, profession and emails, for search. */
  haystack: string;
}

/** Rows drawn at a time; "Show more" adds another page. A big workspace has thousands. */
export const CONTACT_PAGE_SIZE = 100;

/**
 * A ground-up rewrite, not a trim of features/contact/list/list.component.ts
 * (2,465 lines). That original isn't "a table with some extras" - its own
 * import list alone pulls in ~30 dependencies (contact-search's 783-line AI
 * query parser, three alternate view modes - rolodex/persona-card/
 * horizontal-scroll, cockpit automation-activity lights, guided hot/due/
 * VIP/subscriber sections, CSV export, inline note and edit modals) whose
 * combined weight is bigger than every other page ported so far combined.
 * Every one of those is a real, standalone feature - not something to trim
 * piecemeal the way read.component.ts's LinkedIn import or view.component's
 * Signal Engine tab could be cleanly lifted out.
 *
 * What this delivers instead: the actual job of a contact list - browse
 * every contact, search by name/company/email, open one, delete one or
 * many. The "Can't email" and "Marked for deletion" views exist so a list
 * can be cleaned up in one pass; deleting archives to Deleted Contacts,
 * which feeds Lead Vault (NetworkDataService.deleteContacts).
 * Sorting, alternate view modes, CSV export, and inline editing are
 * deferred, not ported thin.
 */
@Component( {
  selector: 'app-list',
  standalone: true,
  imports: [WriteActionDirective, CommonModule, FormsModule, RouterModule, BackToTopComponent, PreloaderComponent, StatusFlowComponent, EmptyStateComponent],
  templateUrl: './list.component.html',
  styleUrl: './list.component.css',
} )
export class ListComponent implements OnInit, OnDestroy {
  readonly pageSize = CONTACT_PAGE_SIZE;
  readonly trackRow = ( _index: number, row: ContactRow ): string => row.id;

  contacts: Contact[] = [];
  /** Every contact as a row, built once per load. */
  rows: ContactRow[] = [];
  /** Rows in the current view and search, sorted. */
  filteredRows: ContactRow[] = [];
  /** The first renderLimit of filteredRows - what's drawn. */
  shownRows: ContactRow[] = [];
  renderLimit = CONTACT_PAGE_SIZE;
  searchText = '';
  view: ContactView = 'all';
  cantEmailCount = 0;
  markedCount = 0;
  /** Anyone besides the user's own record. */
  hasContacts = false;
  isDeleting = false;
  notice = '';
  isLoading = true;
  errorMessage = '';
  sortKey: ContactSortKey = 'name';
  sortDirection: SortDirection = 'asc';
  sortMarks: Record<ContactSortKey, string> = { name: '↑', company: '', email: '', phone: '', status: '' };
  /** null = auth state not resolved yet (still show the preloader); false = resolved and signed out. */
  isSignedIn: boolean | null = null;
  currentUserId = '';
  /** Arrived from Getting Started's "Give relationships a stage"
   * (/contact-list?setStage=1): show a hint and list unstaged contacts first. */
  setStageMode = false;
  /** The row whose stage list is open, and the one just saved. */
  stagePickerFor = '';
  stageSavedFor = '';
  stageErrorFor = '';

  /** Contacts picked for an Outreach email or a bulk delete (design_handoff_network_onboarding 10). */
  readonly selected = new Set<string>();
  /** Every matching contact (not just the drawn page) is selected. */
  allShownSelected = false;
  /** Selected contacts that can actually receive an email. */
  emailableSelectedIds: string[] = [];

  private tenantId = '';
  private authSubscription?: Subscription;
  private readonly outreach = inject( OutreachLinkService );

  constructor (
    private route: ActivatedRoute,
    private router: Router,
    private titleService: Title,
    private authService: NetworkAuthService,
    private dataService: NetworkDataService,
    private contactState: NetworkContactStateService,
    private assistantBus: NetworkAssistantSignalService,
  ) { }

  ngOnInit (): void {
    this.titleService.setTitle( `${environment.COMPANY_NAME} - Contacts` );
    this.setStageMode = this.route.snapshot.queryParamMap.get( 'setStage' ) === '1';

    this.authSubscription = combineLatest( [this.authService.getUserId(), this.authService.getTenantId()] )
      .subscribe( ( [userId, tenantId] ) => {
        this.isSignedIn = !!userId;
        this.currentUserId = userId || '';

        if ( !userId ) {
          // Resolved and signed out - stop spinning instead of waiting on a
          // loadContacts() call that will never come.
          this.isLoading = false;
          return;
        }

        if ( tenantId && tenantId !== this.tenantId ) {
          this.tenantId = tenantId;
          this.loadContacts();
        }
      } );
  }

  ngOnDestroy (): void {
    this.authSubscription?.unsubscribe();
    this.assistantBus.clearPageContext();
  }

  private async loadContacts (): Promise<void> {
    this.isLoading = true;
    this.errorMessage = '';

    try {
      this.setContacts( await this.dataService.getContactRows() );
    } catch ( error ) {
      this.errorMessage = 'Unable to load contacts.';
    } finally {
      this.isLoading = false;
    }
  }

  /** Replaces the contacts and rebuilds every row from them. */
  private setContacts ( contacts: Contact[] ): void {
    this.contacts = contacts;
    this.rows = contacts.map( ( contact ) => this.toRow( contact ) );
    this.hasContacts = this.rows.some( ( row ) => !row.self );
    this.applyFilter();
  }

  private toRow ( contact: Contact ): ContactRow {
    const name = this.displayName( contact );
    const email = contact.emailAddresses?.[0]?.emailAddress || '';
    const self = !!this.currentUserId && contact.id === this.currentUserId;
    const canEmail = !self && !( contact as any ).emailBlocked && !contact.emailAddresses?.[0]?.blocked &&
      !!email && !/\.example$/i.test( email );
    const flags = contact as any;
    const marked = !self && (
      ( contact.status ?? '' ).trim().toLowerCase() === 'deleted' || flags.deleted === true || flags.notEngaged === true
    );
    return {
      contact,
      id: contact.id,
      name,
      initial: name.slice( 0, 1 ).toUpperCase(),
      company: contact.company?.name || '',
      email,
      phone: contact.phoneNumbers?.[0]?.phoneNumber || '',
      tint: contact.status ? stageTint( contact.status ) : null,
      self,
      canEmail,
      cantEmail: !self && !canEmail,
      marked,
      haystack: [
        contact.firstName,
        contact.lastName,
        contact.company?.name,
        contact.profession,
        ...( contact.emailAddresses || [] ).map( ( e ) => e.emailAddress ),
      ].filter( Boolean ).join( ' ' ).toLowerCase(),
    };
  }

  setView ( view: ContactView ): void {
    this.view = view;
    this.applyFilter();
  }

  applyFilter (): void {
    const term = this.searchText.trim().toLowerCase();
    this.cantEmailCount = this.rows.filter( ( row ) => row.cantEmail ).length;
    this.markedCount = this.rows.filter( ( row ) => row.marked ).length;

    const inView = this.rows.filter( ( row ) => this.view === 'cantEmail' ? row.cantEmail : this.view === 'marked' ? row.marked : true );
    const matches = !term ? inView : inView.filter( ( row ) => row.haystack.includes( term ) );

    this.filteredRows = this.sortRows( matches );
    // Never act on rows the user can't see: a bulk delete only covers what matches.
    const matching = new Set( this.filteredRows.map( ( row ) => row.id ) );
    [...this.selected].forEach( ( id ) => { if ( !matching.has( id ) ) this.selected.delete( id ); } );
    this.renderLimit = CONTACT_PAGE_SIZE;
    this.refreshShown();
    this.refreshSelection();
    this.publishAssistantContext();
  }

  /** Draws another page of matching contacts. */
  showMore (): void {
    this.renderLimit += CONTACT_PAGE_SIZE;
    this.refreshShown();
  }

  private refreshShown (): void {
    this.shownRows = this.filteredRows.slice( 0, this.renderLimit );
  }

  private publishAssistantContext (): void {
    this.assistantBus.setPageContext( {
      feature: 'contact-list',
      page: 'contact-list',
      mode: 'list',
      title: 'Contact List',
      summary: {
        totalContacts: this.contacts.length,
        filteredCount: this.filteredRows.length,
        searchText: this.searchText.trim(),
        view: this.view,
        cantEmailCount: this.cantEmailCount,
        markedForDeletionCount: this.markedCount,
      },
    } );
  }

  sortBy ( key: ContactSortKey ): void {
    if ( this.sortKey === key ) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      this.sortDirection = 'asc';
    }
    this.sortMarks = { name: '', company: '', email: '', phone: '', status: '' };
    this.sortMarks[key] = this.sortDirection === 'asc' ? '↑' : '↓';

    this.filteredRows = this.sortRows( this.filteredRows );
    this.refreshShown();
  }

  private sortRows ( rows: ContactRow[] ): ContactRow[] {
    const collator = new Intl.Collator( undefined, { sensitivity: 'base', numeric: true } );
    const value = ( row: ContactRow ): string => {
      switch ( this.sortKey ) {
        case 'company': return row.company;
        case 'email': return row.email;
        case 'phone': return row.phone;
        case 'status': return row.contact.status || '';
        case 'name':
        default: return row.name;
      }
    };
    const direction = this.sortDirection === 'asc' ? 1 : -1;
    const sorted = [...rows].sort( ( a, b ) => direction * collator.compare( value( a ), value( b ) ) );
    if ( !this.setStageMode ) return sorted;
    // Contacts still needing a stage first (stable within each group).
    return [
      ...sorted.filter( ( row ) => !row.contact.status?.trim() ),
      ...sorted.filter( ( row ) => !!row.contact.status?.trim() ),
    ];
  }

  toggleSelected ( row: ContactRow ): void {
    if ( this.selected.has( row.id ) ) this.selected.delete( row.id );
    else this.selected.add( row.id );
    this.refreshSelection();
  }

  /** Every matching contact except the user's own record. */
  private selectableRows (): ContactRow[] {
    return this.filteredRows.filter( ( row ) => !row.self );
  }

  toggleAllShown (): void {
    const rows = this.selectableRows();
    if ( this.allShownSelected ) rows.forEach( ( row ) => this.selected.delete( row.id ) );
    else rows.forEach( ( row ) => this.selected.add( row.id ) );
    this.refreshSelection();
  }

  clearSelection (): void {
    this.selected.clear();
    this.refreshSelection();
  }

  /** Recomputes what the select-all box and the bulk bar show. */
  private refreshSelection (): void {
    const rows = this.selectableRows();
    this.allShownSelected = rows.length > 0 && rows.every( ( row ) => this.selected.has( row.id ) );
    this.emailableSelectedIds = this.selected.size
      ? this.rows.filter( ( row ) => row.canEmail && this.selected.has( row.id ) ).map( ( row ) => row.id )
      : [];
  }

  emailSelected (): void {
    const ids = this.emailableSelectedIds;
    if ( !ids.length ) return;
    this.outreach.open( ids, `${ids.length} ${ids.length === 1 ? 'contact' : 'contacts'}` );
  }

  async deleteSelected (): Promise<void> {
    const toDelete = this.rows.filter( ( row ) => this.selected.has( row.id ) && !row.self ).map( ( row ) => row.contact );
    if ( !toDelete.length || this.isDeleting ) return;

    const count = toDelete.length;
    const noun = count === 1 ? 'contact' : 'contacts';
    if ( !confirm( `Delete ${count} ${noun}? They'll move to Deleted Contacts.` ) ) return;

    this.isDeleting = true;
    this.errorMessage = '';
    this.notice = '';
    try {
      const { deleted, failed } = await this.dataService.deleteContacts( this.tenantId, toDelete );
      const gone = new Set( deleted );
      deleted.forEach( ( id ) => this.selected.delete( id ) );
      this.removeRows( gone );
      if ( deleted.length ) this.notice = `Deleted ${deleted.length} ${deleted.length === 1 ? 'contact' : 'contacts'}.`;
      if ( failed.length ) this.errorMessage = `Couldn't delete ${failed.length} ${failed.length === 1 ? 'contact' : 'contacts'}. They're still selected - try again.`;
    } finally {
      this.isDeleting = false;
    }
  }

  /** Drops deleted contacts, keeping how many rows are drawn. */
  private removeRows ( gone: Set<string> ): void {
    const limit = this.renderLimit;
    this.contacts = this.contacts.filter( ( contact ) => !gone.has( contact.id ) );
    this.rows = this.rows.filter( ( row ) => !gone.has( row.id ) );
    this.hasContacts = this.rows.some( ( row ) => !row.self );
    this.applyFilter();
    this.renderLimit = limit;
    this.refreshShown();
  }

  emailOne ( event: Event, row: ContactRow ): void {
    event.stopPropagation();
    this.outreach.open( [row.id], row.name );
  }

  toggleStagePicker ( event: Event, row: ContactRow ): void {
    event.stopPropagation();
    this.stagePickerFor = this.stagePickerFor === row.id ? '' : row.id;
  }

  /** Saves a stage straight from the list - no trip through the edit page. */
  async saveStage ( row: ContactRow, status: string ): Promise<void> {
    const { id, contact } = row;
    const previous = contact.status;
    contact.status = status;
    row.tint = status ? stageTint( status ) : null;
    this.stagePickerFor = '';
    this.stageErrorFor = '';
    try {
      await this.dataService.updateContact( this.tenantId, id, { status } );
      this.stageSavedFor = id;
      setTimeout( () => { if ( this.stageSavedFor === id ) this.stageSavedFor = ''; }, 2000 );
    } catch {
      contact.status = previous;
      row.tint = previous ? stageTint( previous ) : null;
      this.stageErrorFor = id;
    }
  }

  private displayName ( contact: Contact ): string {
    const name = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
    return name || contact.company?.name || 'Unnamed contact';
  }

  openContact ( row: ContactRow ): void {
    if ( row.id ) {
      this.router.navigate( ['/contact', row.id] );
    }
  }

  addContact (): void {
    this.contactState.resetContact();
    this.router.navigate( ['/contact-edit'] );
  }

  async deleteContact ( event: Event, row: ContactRow ): Promise<void> {
    event.stopPropagation();
    if ( !row.id ) return;

    const confirmation = confirm( `Delete ${row.name}?` );
    if ( !confirmation ) return;

    try {
      await this.dataService.deleteContact( this.tenantId, row.contact );
      this.selected.delete( row.id );
      this.removeRows( new Set( [row.id] ) );
    } catch ( error ) {
      this.errorMessage = 'Unable to delete that contact.';
    }
  }
}
