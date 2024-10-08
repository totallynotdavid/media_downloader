import {DownloaderConfig, DownloadOptions, MediaInfo, PlatformHandler} from '@/types';
import {HttpClient} from '@/utils/http-client';
import {FileDownloader} from '@/utils/file-downloader';
import {MediaNotFoundError} from '@/types/errors';
import path from 'node:path';
import logger from '@/utils/logger';
import {ImgurApiData, ImgurApiResponse} from '@/types/imgur';

/**
 * ImgurHandler is responsible for handling media retrieval from Imgur links.
 * It supports single images, albums, and gallery links.
 *
 * @testCases
 * - Single image: https://i.imgur.com/7q4TxW7.png
 * - Single image as a gallery: https://imgur.com/gallery/ouMQkN1
 * - Album with multiple images: https://imgur.com/gallery/art-gallery-ready-to-heist-free-dnd-ttrpg-maps-dTFUK1E
 * - Video album: https://imgur.com/gallery/mouth-movements-hxXHU13
 */
export default class ImgurHandler implements PlatformHandler {
    private readonly clientId: string;

    constructor(
        private httpClient: HttpClient,
        private fileDownloader: FileDownloader
    ) {
        this.clientId = '546c25a59c58ad7';
    }

    /**
     * Determines if the given URL is a valid Imgur URL.
     * @param url The URL to validate.
     * @returns True if valid, false otherwise.
     */
    public isValidUrl(url: string): boolean {
        const imgurRegex = /^https?:\/\/(www\.)?(i\.)?imgur\.com\/.+$/;
        return imgurRegex.test(url);
    }

    /**
     * Retrieves media information from an Imgur URL.
     * @param url The Imgur URL.
     * @param options Download options.
     * @param config Downloader configuration.
     * @returns MediaInfo object containing media details.
     */
    public async getMediaInfo(
        url: string,
        options: Required<DownloadOptions>,
        config: DownloaderConfig
    ): Promise<MediaInfo> {
        const {type, id} = this.classifyImgurLink(url);
        const data = await this.fetchMediaInfo(type, id);

        if (!data) {
            throw new MediaNotFoundError('Media not found on Imgur.');
        }

        const mediaUrls = this.extractUrls(data);
        const metadata = this.extractMetadata(data);

        let urls: MediaInfo['urls'] = mediaUrls.map(mediaUrl => ({
            url: mediaUrl,
            quality: 'original',
            format: this.getFileExtension(mediaUrl),
            size: 0,
        }));

        if (options.downloadMedia) {
            urls = await this.downloadMedia(urls, config.downloadDir, metadata.title);
        }

        return {
            urls,
            metadata: {
                title: metadata.title,
                author: data.account_url || 'Unknown',
                platform: 'Imgur',
                views: data.views,
                likes: data.ups - data.downs,
            },
        };
    }

    /**
     * Downloads media files and updates the URLs with local paths.
     * @param urls Array of URL objects to download.
     * @param downloadDir Directory to save downloaded files.
     * @param title Base title for the files.
     * @returns Updated array of URL objects with local paths.
     */
    private async downloadMedia(
        urls: MediaInfo['urls'],
        downloadDir: string,
        title: string
    ): Promise<MediaInfo['urls']> {
        return Promise.all(
            urls.map(async (urlInfo, index) => {
                const sanitizedTitle = title
                    .replace(/[^\w\s-]/g, '')
                    .replace(/\s+/g, '_');
                const fileName = `${sanitizedTitle}_${index + 1}.${urlInfo.format}`;

                try {
                    const localPath = await this.fileDownloader.downloadFile(
                        urlInfo.url,
                        downloadDir,
                        fileName
                    );
                    return {...urlInfo, localPath};
                } catch (error) {
                    logger.error(`Failed to download file: ${error}`);
                    return urlInfo;
                }
            })
        );
    }

    /**
     * Classifies the Imgur link to determine its type and extract the media ID.
     * @param url The Imgur URL.
     * @returns An object containing the type and ID of the media.
     */
    private classifyImgurLink(url: string): {type: string; id: string} {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);

        let type: string;
        let id: string;

        if (urlObj.hostname.startsWith('i.')) {
            // Direct image link
            type = 'image';
            id = pathParts[0]?.split('.')[0] ?? '';
        } else if (pathParts[0] === 'gallery' || pathParts[0] === 'a') {
            // Gallery or album
            type = 'album';
            id = pathParts[1] ?? '';
        } else {
            // Single image page
            type = 'image';
            id = pathParts[0] ?? '';
        }

        logger.info(`Classified Imgur link: type=${type}, id=${id}`);
        return {type, id};
    }

    /**
     * Fetches media information from the Imgur API.
     * @param type The type of media ('image' or 'album').
     * @param id The media ID.
     * @returns The Imgur API response data.
     */
    private async fetchMediaInfo(type: string, id: string): Promise<ImgurApiData | null> {
        const endpoint = `https://api.imgur.com/3/${type}/${id}`;

        try {
            const response = await this.httpClient.get<ImgurApiResponse>(endpoint, {
                headers: {Authorization: `Client-ID ${this.clientId}`},
            });

            if (response.data.success && response.data.data) {
                return response.data.data;
            }
            return null;
        } catch (error) {
            logger.error(`Error fetching media info from Imgur: ${error}`);
            throw new MediaNotFoundError('Failed to fetch media info from Imgur.');
        }
    }

    /**
     * Extracts media URLs from the Imgur API data.
     * @param data The Imgur API data.
     * @returns An array of media URLs.
     */
    private extractUrls(data: ImgurApiData): string[] {
        if (data.is_album && data.images) {
            return data.images.map(img => img.link);
        } else if (data.link) {
            return [data.link];
        }
        return [];
    }

    /**
     * Extracts metadata from the Imgur API data.
     * @param data The Imgur API data.
     * @returns An object containing metadata.
     */
    private extractMetadata(data: ImgurApiData): {title: string} {
        let title = data.title || 'Untitled';

        if (data.description) {
            title += ` - ${data.description}`;
        }

        if (data.is_album) {
            title += ` (Album)`;
        }

        return {
            title: title.trim(),
        };
    }

    /**
     * Utility method to extract file extension from a URL.
     * @param url The URL string.
     * @returns The file extension.
     */
    private getFileExtension(url: string): string {
        const parsed = path.parse(new URL(url).pathname);
        return parsed.ext.replace('.', '') || 'unknown';
    }
}
