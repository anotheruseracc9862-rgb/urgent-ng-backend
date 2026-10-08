import { Injectable } from '@nestjs/common';
import { ReferenceDataService } from '../reference-data/reference-data.service.js';

export interface ProhibitedMatch {
  keyword: string;
  category: string;
  policyVersion: string;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Keyword screen for errand text (Backend PRD 11.9). A rule matches when its keyword (or its plural)
 * appears as a whole word or phrase, ignoring case and extra spacing. Matching is a first line only: a clear
 * hit blocks publishing, and runners can still decline or report an unsafe errand.
 */
@Injectable()
export class ProhibitedItemsService {
  constructor(private readonly reference: ReferenceDataService) {}

  async find(...texts: Array<string | null | undefined>): Promise<ProhibitedMatch[]> {
    const haystack = ` ${texts.filter(Boolean).join(' \n ').toLowerCase().replace(/\s+/g, ' ')} `;
    if (haystack.trim() === '') {
      return [];
    }
    const rules = await this.reference.prohibitedItems();
    const matches: ProhibitedMatch[] = [];
    for (const rule of rules) {
      const keyword = rule.keyword.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!keyword) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(keyword)}(?:s|es)?(?![\\p{L}\\p{N}])`, 'u');
      if (pattern.test(haystack)) {
        matches.push({ keyword: rule.keyword, category: rule.category, policyVersion: rule.policyVersion });
      }
    }
    return matches;
  }
}
